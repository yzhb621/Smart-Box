const request = require('supertest');
const mockRecords = [];
const mockStore = new Map();
let mockQueue = Promise.resolve();
jest.mock('../config/firebaseAdmin', () => {
  const users = {recipient:{email:'recipient@example.com'},other:{email:'other@example.com'}};
  const ref = (name,id) => ({key:name+'/'+id, async get(){ const data=name==='users'?users[id]:mockStore.get(this.key); return {exists:!!data,data:()=>data}; }, async update(update){ mockStore.set(this.key,{...mockStore.get(this.key),...update}); }});
  const db = {collection(name){return {doc(id){return ref(name,id);}};}, runTransaction(handler){
    const operation = mockQueue.then(async () => {
      const writes=[];
      const result=await handler({get:r=>r.get(),create:(r,data)=>writes.push(()=>{mockStore.set(r.key,data);mockRecords.push(data);}),update:(r,data)=>writes.push(()=>mockStore.set(r.key,{...mockStore.get(r.key),...data})),set:(r,data)=>writes.push(()=>mockStore.set(r.key,data))});
      writes.forEach(write=>write()); return result;
    });
    mockQueue=operation.catch(()=>{});return operation;
  }};
  const firestore=()=>db;firestore.FieldValue={serverTimestamp:()=> 'server-timestamp'};
  return {firestore,auth:()=>({verifyIdToken:async token=>{if(['courier','recipient','other','admin'].includes(token))return {uid:token==='courier'?'courier-user':token,role:token==='courier'?'courier':token==='admin'?'admin':'user'};throw new Error('Invalid token');}})};
});
const app = require('../index');
const details = {recipientId:'recipient',postCode:'0000',serialNumber:'4',areaId:'0000',qrKeyId:Buffer.from('123456').toString('base64'),deliveryId:'12345678-1234-4234-8234-123456789abc',expiresAt:Date.now()+500000};
beforeEach(() => { mockRecords.length = 0; mockStore.clear(); mockQueue=Promise.resolve(); details.expiresAt=Date.now()+500000; });
test('courier delivery persists complete fields and trusted identity', async () => {
  const response = await request(app).post('/api/parcels').set('Authorization','Bearer courier').send({...details,courierId:'forged'});
  expect(response.status).toBe(200);
  expect(response.body.id).toMatch(/^[a-f0-9]{64}$/);
  expect(mockRecords[0]).toMatchObject({courierId:'courier-user',recipientId:'recipient',serialNumber:'000000000004',status:'delivered',areaId:'0000',retrievedAt:null,deliveryAddress:null,createdAt:'server-timestamp'});
  expect(Object.values(mockRecords[0])).not.toContain(undefined);
});
test('another recipient cannot create someone else’s delivery', async () => {
  const response = await request(app).post('/api/parcels').set('Authorization','Bearer other').send(details);
  expect(response.status).toBe(403);
  expect(mockRecords).toHaveLength(0);
});
test('invalid postcode or pickup code does not create a parcel', async () => {
  const response = await request(app).post('/api/parcels').set('Authorization','Bearer courier').send({...details,postCode:'bad'});
  expect(response.status).toBe(400);
  expect(mockRecords).toHaveLength(0);
});

const create = (changes={}) => request(app).post('/api/parcels').set('Authorization','Bearer courier').send({...details,...changes});
const post = (path,body={},token='courier') => request(app).post(path).set('Authorization','Bearer '+token).send(body);
const stored = id => mockStore.get('parcels/'+id);
test('refresh and concurrent delivery confirmation create only one parcel', async()=>{
 const responses=await Promise.all([create(),create(),create()]);
 expect(responses.map(r=>r.status)).toEqual([200,200,200]);expect(mockRecords).toHaveLength(1);
 expect(new Set(responses.map(r=>r.body.id)).size).toBe(1);
 expect((await create()).body.duplicate).toBe(true);
});
test('reusing a delivery ID with changed recipient or code is rejected',async()=>{
 await create();expect((await create({qrKeyId:Buffer.from('654321').toString('base64')})).status).toBe(409);expect(mockRecords).toHaveLength(1);
});
test('expired delivery cannot create a record',async()=>{
 expect((await create({expiresAt:Date.now()-1})).status).toBe(400);expect(mockRecords).toHaveLength(0);
});
test('pickup requires ownership, correct code and unexpired delivery',async()=>{
 const id=(await create()).body.id;
 expect((await post('/api/pickups/verify',{deliveryId:details.deliveryId,qrKeyId:details.qrKeyId},'other')).status).toBe(403);
 expect((await post('/api/pickups/verify',{deliveryId:details.deliveryId,qrKeyId:Buffer.from('654321').toString('base64')})).status).toBe(403);
 stored(id).expiresAt=Date.now()-1;
 expect((await post('/api/pickups/verify',{deliveryId:details.deliveryId,qrKeyId:details.qrKeyId})).status).toBe(410);
 expect(stored(id).status).toBe('delivered');
});
test('verified pickup completion is idempotent and retries after code expiry',async()=>{
 const id=(await create()).body.id;
 expect((await post('/api/parcels/'+id+'/retrieve',{qrKeyId:details.qrKeyId})).status).toBe(409);
 expect((await post('/api/pickups/verify',{deliveryId:details.deliveryId,qrKeyId:details.qrKeyId})).body.id).toBe(id);
 stored(id).expiresAt=Date.now()-1;
 expect((await post('/api/parcels/'+id+'/retrieve',{qrKeyId:details.qrKeyId})).body.duplicate).toBe(false);
 expect((await post('/api/parcels/'+id+'/retrieve',{qrKeyId:details.qrKeyId})).body.duplicate).toBe(true);
 expect(stored(id)).toMatchObject({status:'retrieved',retrievedAt:'server-timestamp'});
 expect((await post('/api/pickups/verify',{deliveryId:details.deliveryId,qrKeyId:details.qrKeyId})).status).toBe(409);
});
beforeEach(()=>{
 process.env.PUBLICKEY='test-public';process.env.EMAILJS_SERVICE_ID='test-service';process.env.EMAILJS_PICKUP_TEMPLATE_ID='test-template';process.env.SCB_BASE_URL='https://example.com';
});
afterEach(()=>jest.restoreAllMocks());
test('email sends once across page reloads and reads recipient from database',async()=>{
 const send=jest.spyOn(global,'fetch').mockResolvedValue({ok:true});const id=(await create()).body.id;
 expect((await post('/api/parcels/'+id+'/notify',{email:'forged@example.com'})).status).toBe(200);
 expect((await post('/api/parcels/'+id+'/notify')).body.notificationStatus).toBe('sent');expect(send).toHaveBeenCalledTimes(1);
 expect(JSON.parse(send.mock.calls[0][1].body).template_params.email).toBe('recipient@example.com');
});
test('provider rejection persists pending email for safe retry',async()=>{
 const send=jest.spyOn(global,'fetch').mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:true});const id=(await create()).body.id;
 expect((await post('/api/parcels/'+id+'/notify')).status).toBe(502);expect(stored(id).notificationStatus).toBe('pending');
 mockStore.delete('system/email-dispatch');
 expect((await post('/api/parcels/'+id+'/notify')).status).toBe(200);expect(send).toHaveBeenCalledTimes(2);expect(mockRecords).toHaveLength(1);
});
test('network ambiguity blocks automatic duplicate email',async()=>{
 const send=jest.spyOn(global,'fetch').mockRejectedValue(new Error('timeout'));const id=(await create()).body.id;
 expect((await post('/api/parcels/'+id+'/notify')).status).toBe(502);
 expect((await post('/api/parcels/'+id+'/notify')).status).toBe(409);expect(send).toHaveBeenCalledTimes(1);expect(stored(id).notificationStatus).toBe('uncertain');
});
test('concurrent email requests cannot both send',async()=>{
 const send=jest.spyOn(global,'fetch').mockImplementation(()=>new Promise(resolve=>setTimeout(()=>resolve({ok:true}),30)));const id=(await create()).body.id;
 const results=await Promise.all([post('/api/parcels/'+id+'/notify'),post('/api/parcels/'+id+'/notify')]);
 expect(results.map(r=>r.status).sort()).toEqual([200,409]);expect(send).toHaveBeenCalledTimes(1);
});
test('unconfigured or unauthorised notification never calls provider',async()=>{
 const send=jest.spyOn(global,'fetch');const id=(await create()).body.id;
 expect((await post('/api/parcels/'+id+'/notify',{},'other')).status).toBe(403);
 delete process.env.EMAILJS_SERVICE_ID;
 expect((await post('/api/parcels/'+id+'/notify')).status).toBe(503);expect(send).not.toHaveBeenCalled();
});

test('only admin can resolve an uncertain email after provider review',async()=>{
 const send=jest.spyOn(global,'fetch').mockRejectedValue(new Error('timeout'));const id=(await create()).body.id;
 await post('/api/parcels/'+id+'/notify');
 expect((await post('/api/parcels/'+id+'/notification-resolution',{providerOutcome:'not_sent'})).status).toBe(403);
 expect((await post('/api/parcels/'+id+'/notification-resolution',{providerOutcome:'not_sent'},'admin')).status).toBe(200);
 expect(stored(id).notificationStatus).toBe('pending');
 send.mockResolvedValue({ok:true});mockStore.delete('system/email-dispatch');
 expect((await post('/api/parcels/'+id+'/notify')).status).toBe(200);
});

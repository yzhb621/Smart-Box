const request = require('supertest');
const mockRecords = [];
jest.mock('../config/firebaseAdmin', () => {
  const users = { recipient: {email:'recipient@example.com'}, other: {email:'other@example.com'} };
  const db = { collection(name) {
    return {
      doc(id) { return { async get() { return {exists: !!users[id], data: () => users[id]}; } }; },
      async add(record) { mockRecords.push(record); return {id:'parcel-1'}; },
    };
  }};
  const firestore = () => db;
  firestore.FieldValue = {serverTimestamp: () => 'server-timestamp'};
  return {firestore, auth: () => ({verifyIdToken: async (token) => {
    if (token === 'courier') return {uid:'courier-user',role:'courier'};
    if (token === 'recipient') return {uid:'recipient',role:'user'};
    if (token === 'other') return {uid:'other',role:'user'};
    throw new Error('Invalid token');
  }})};
});
const app = require('../index');
const details = {recipientId:'recipient',postCode:'0000',serialNumber:'4',areaId:'0000',qrKeyId:Buffer.from('123456').toString('base64')};
beforeEach(() => { mockRecords.length = 0; });
test('courier delivery persists complete fields and trusted identity', async () => {
  const response = await request(app).post('/api/parcels').set('Authorization','Bearer courier').send({...details,courierId:'forged'});
  expect(response.status).toBe(200);
  expect(response.body.id).toBe('parcel-1');
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

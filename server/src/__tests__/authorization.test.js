const request = require('supertest');
const app = require('../index');

describe('API authentication and profile setup', () => {
  it('requires a token even in the test environment', async () => {
    expect((await request(app).get('/api/profile/test-user')).status).toBe(401);
  });
  it('rejects an invalid token', async () => {
    expect((await request(app).get('/api/profile/test-user').set('Authorization', 'Bearer invalid')).status).toBe(401);
  });
  it('creates a missing profile for the authenticated UID', async () => {
    const response = await request(app).post('/api/profile/test-user')
      .set('Authorization', 'Bearer test-user').send({ name: 'Recipient', theme: 'dark' });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
  it('rejects malformed profile fields', async () => {
    const response = await request(app).post('/api/profile/test-user')
      .set('Authorization', 'Bearer test-user').send({ name: { unexpected: true } });
    expect(response.status).toBe(400);
  });
  it('does not grant administrative box access to ordinary users', async () => {
    const response = await request(app).delete('/api/boxes/example').set('Authorization', 'Bearer test-user');
    expect(response.status).toBe(403);
  });
  it('redirects the legacy data page to parcel history', async () => {
    const response = await request(app).get('/data');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/history');
  });
});

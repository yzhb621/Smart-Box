const request = require('supertest');
const app = require('../index');

describe('GET /api/profile/:email', () => {
  it('returns empty object for unknown email (mocked firestore)', async () => {
    const res = await request(app).get('/api/profile/notfound@example.com');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({});
  });
});

const request = require('supertest');
const app = require('../index');

describe('POST /signup', () => {
  it('creates a user and returns success when email and password provided', async () => {
    const res = await request(app)
      .post('/signup')
      .send({ email: `test+${Date.now()}@example.com`, password: 'password123' })
      .set('Accept', 'application/json');

    expect([200,201,202].includes(res.statusCode)).toBe(true);
    expect(res.body).toHaveProperty('success');
    expect(res.body.success).toBe(true);
    expect(res.body).toHaveProperty('uid');
  });

  it('returns 400 when missing fields', async () => {
    const res = await request(app).post('/signup').send({ email: '' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('success', false);
  });
});

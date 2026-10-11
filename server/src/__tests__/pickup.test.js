const request = require('supertest');
const app = require('../index');

describe('pickup page', () => {
  it('serves the page without query parameters', async () => {
    const response = await request(app).get('/p/');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/html/);
  });
  it('rejects malformed pickup email before sending the page', async () => {
    const response = await request(app).get('/p/').query({ e: 'invalid' });
    expect(response.status).toBe(400);
    expect(response.text).toBe('Invalid email.');
  });
  it('serves the page for an encoded email', async () => {
    const response = await request(app).get('/p/').query({
      e: Buffer.from('recipient@example.com').toString('base64'),
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/html/);
  });
});

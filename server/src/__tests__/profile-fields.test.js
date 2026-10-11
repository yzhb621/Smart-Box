const { profileUpdates } = require('../utils/validators');
test('profile updates preserve editable fields without granting a role or replacing identity', () => {
  expect(profileUpdates({ name: ' Recipient ', role: 'admin', uid: 'someone-else', email: 'other@example.com' }))
    .toEqual({ name: 'Recipient' });
});
test('profile updates reject invalid preferences', () => {
  expect(profileUpdates({ theme: 'unexpected' })).toBeNull();
  expect(profileUpdates({ notifications: 'yes' })).toBeNull();
});

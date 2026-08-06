function decodeBase64(input) {
  if (!input) return '';
  try {
    return Buffer.from(input, 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

function isEmailString(s) {
  if (!s) return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(s);
}

module.exports = { decodeBase64, isEmailString };

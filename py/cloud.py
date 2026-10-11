"""Authenticated cloud requests and durable controller state; no GPIO dependencies."""
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import urlparse


class CloudClient:
    def __init__(self, base_url, token_file=None):
        self.base_url = base_url.rstrip('/')
        parsed = urlparse(self.base_url)
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1')):
            raise ValueError('Cloud URL must use HTTPS (HTTP allowed only for localhost).')
        self.token_file = token_file or os.environ.get('SCB_ID_TOKEN_FILE')

    def post(self, path, body):
        if not self.token_file:
            raise RuntimeError('Set SCB_ID_TOKEN_FILE to an existing Firebase ID token file.')
        token = Path(self.token_file).read_text(encoding='utf-8').strip()
        if not token:
            raise RuntimeError('Firebase ID token file is empty.')
        request = Request(self.base_url + path, data=json.dumps(body).encode(),
                          headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token}, method='POST')
        try:
            with urlopen(request, timeout=15) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code == 401:
                raise RuntimeError('Firebase sign-in expired. Replace the ID token file.') from error
            raise RuntimeError('Cloud rejected request (HTTP %s).' % error.code) from error


class StateStore:
    def __init__(self, filename=None):
        self.path = Path(filename or os.environ.get('SCB_STATE_FILE', str(Path(__file__).with_name('.scb-state.json'))))

    def load(self):
        if not self.path.exists():
            return None
        return json.loads(self.path.read_text(encoding='utf-8'))

    def save(self, state):
        temporary = self.path.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(state, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.path)

    def clear(self):
        self.path.unlink(missing_ok=True)

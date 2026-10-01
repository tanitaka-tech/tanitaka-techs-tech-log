"""YouTube read-only OAuth setup for this local digest."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen


DIRECTORY = Path(__file__).resolve().parents[2] / ".digest-cache" / "google-oauth"
CLIENT_FILE = DIRECTORY / "client_secret.json"
TOKEN_FILE = DIRECTORY / "token.json"
SCOPE = "https://www.googleapis.com/auth/youtube.readonly"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--add", action="store_true", help="Keep the existing token and add another YouTube channel")
    parser.add_argument("--login-hint", help="Google account email to show in the account picker")
    args = parser.parse_args()
    client = json.loads(CLIENT_FILE.read_text(encoding="utf-8"))["installed"]
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()
    ).decode("ascii").rstrip("=")
    state = secrets.token_urlsafe(32)

    class Callback(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path != "/oauth2callback":
                self.send_error(404)
                return
            values = parse_qs(parsed.query)
            if values.get("state", [None])[0] != state:
                self.send_error(400, "State mismatch")
                return
            self.server.result = values
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("認可処理を受け付けました。このタブを閉じてください。".encode())

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Callback)
    server.timeout = 1
    redirect_uri = f"http://127.0.0.1:{server.server_port}/oauth2callback"
    auth_params = {
        "client_id": client["client_id"],
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "select_account consent" if args.add else "consent",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    if args.login_hint:
        auth_params["login_hint"] = args.login_hint
    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(auth_params)
    subprocess.run(["open", "-a", "Google Chrome", auth_url], check=True)
    print("Google Chrome で YouTube の読み取り認可を開きました。", flush=True)

    deadline = time.monotonic() + 300
    while not hasattr(server, "result") and time.monotonic() < deadline:
        server.handle_request()
    server.server_close()
    if not hasattr(server, "result"):
        raise SystemExit("認可が5分以内に完了しませんでした。")
    result = server.result
    if "error" in result:
        raise SystemExit(f"Google 認可エラー: {result['error'][0]}")
    code = result.get("code", [None])[0]
    if not code:
        raise SystemExit("認可コードが返されませんでした。")

    request = Request(
        "https://oauth2.googleapis.com/token",
        data=urlencode({
            "client_id": client["client_id"],
            "client_secret": client["client_secret"],
            "code": code,
            "code_verifier": verifier,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        }).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        token = json.load(response)
    if SCOPE not in token.get("scope", "").split():
        raise SystemExit("YouTube の読み取り権限が付与されませんでした。")
    if not token.get("refresh_token"):
        raise SystemExit("更新用トークンが返されませんでした。")
    token["created_at"] = int(time.time())

    if args.add:
        channel_request = Request(
            "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
            headers={"Authorization": "Bearer " + token["access_token"]},
        )
        with urlopen(channel_request, timeout=30) as response:
            channels = json.load(response).get("items", [])
        if len(channels) != 1:
            raise SystemExit(f"YouTube チャンネルを一意に特定できませんでした: {len(channels)} 件")
        channel = channels[0]
        destination = DIRECTORY / f"token-{channel['id']}.json"
    else:
        destination = TOKEN_FILE

    temporary = destination.with_suffix(".json.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(token, output, ensure_ascii=False, indent=2)
        output.write("\n")
    os.replace(temporary, destination)
    print(f"読み取り専用トークンを保存しました: {destination}")
    if args.add:
        print(f"認可された YouTube チャンネル: {channel['snippet']['title']}")


if __name__ == "__main__":
    main()

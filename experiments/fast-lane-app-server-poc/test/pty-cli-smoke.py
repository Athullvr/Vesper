#!/usr/bin/env python3
"""Exercise the real Vesper CLI over a PTY without starting Codex."""

import errno
import fcntl
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "bin" / "vesper.js"
OUTPUT_LIMIT = 32 * 1024
CURSOR_HIDE = b"\x1b[?25l"


class PtyRun:
    def __init__(self, node, project, env):
        self.master, self.slave = pty.openpty()
        self.before = termios.tcgetattr(self.slave)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        self.output = bytearray()
        self.process = subprocess.Popen(
            [node, str(CLI), str(project)],
            cwd=project,
            env=env,
            stdin=self.slave,
            stdout=self.slave,
            stderr=self.slave,
            close_fds=True,
            start_new_session=True,
        )

    def _read(self, timeout):
        ready, _, _ = select.select([self.master], [], [], timeout)
        if not ready:
            return
        try:
            chunk = os.read(self.master, 4096)
        except OSError as error:
            if error.errno == errno.EIO:
                return
            raise
        self.output.extend(chunk)
        if len(self.output) > OUTPUT_LIMIT:
            raise AssertionError(f"PTY output exceeded {OUTPUT_LIMIT} bytes")

    def wait_for(self, marker, timeout=8, start=0):
        deadline = time.monotonic() + timeout
        while marker not in self.output[start:]:
            if self.process.poll() is not None:
                self._read(0.05)
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            self._read(min(remaining, 0.1))
        if marker not in self.output[start:]:
            excerpt = bytes(self.output[-2000:]).decode("utf-8", "replace")
            raise AssertionError(f"Did not observe {marker!r}; recent PTY output: {excerpt!r}")
        return bytes(self.output)

    def assert_raw_prompt(self):
        attrs = termios.tcgetattr(self.slave)
        local_modes = attrs[3]
        for mode, name in ((termios.ICANON, "canonical input"), (termios.ECHO, "echo"), (termios.ISIG, "signal processing")):
            if local_modes & mode:
                raise AssertionError(f"PTY prompt did not enter raw mode: {name} remained enabled")

    def send(self, data):
        os.write(self.master, data)

    def resize(self, columns, rows):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.kill(self.process.pid, signal.SIGWINCH)

    def wait_exit(self, timeout=8):
        deadline = time.monotonic() + timeout
        while self.process.poll() is None and time.monotonic() < deadline:
            self._read(0.1)
        if self.process.poll() is None:
            raise AssertionError("Vesper did not exit before the timeout")
        self.process.wait(timeout=1)
        self._read(0.1)
        if self.process.returncode != 0:
            excerpt = bytes(self.output[-2000:]).decode("utf-8", "replace")
            raise AssertionError(f"Vesper exited with {self.process.returncode}: {excerpt!r}")
        if termios.tcgetattr(self.slave) != self.before:
            raise AssertionError("PTY terminal modes were not restored on exit")
        try:
            os.killpg(self.process.pid, 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError("Vesper's process group remained after exit")
        return bytes(self.output)

    def close(self):
        if self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=2)
        os.close(self.master)
        os.close(self.slave)


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    if os.name != "posix":
        raise SystemExit("PTY CLI smoke requires a POSIX system with Python 3.")
    node = shutil.which("node")
    git = shutil.which("git")
    if not node or not git:
        raise SystemExit("PTY CLI smoke requires Node.js and Git on PATH.")

    with tempfile.TemporaryDirectory(prefix="vesper-pty-smoke-") as temporary:
        root = Path(temporary)
        project = root / "project"
        bin_dir = root / "bin"
        home = root / "home"
        codex_home = root / "codex-home"
        vesper_home = root / "vesper-home"
        project.mkdir()
        bin_dir.mkdir()
        for directory in (home, codex_home, vesper_home):
            directory.mkdir()
        (bin_dir / "node").symlink_to(Path(node).resolve())
        (bin_dir / "git").symlink_to(Path(git).resolve())
        env = {
            "PATH": str(bin_dir),
            "HOME": str(home),
            "CODEX_HOME": str(codex_home),
            "VESPER_HOME": str(vesper_home),
            "XDG_CONFIG_HOME": str(root / "xdg-config"),
            "XDG_CACHE_HOME": str(root / "xdg-cache"),
            "TERM": "xterm-256color",
            "LANG": "C.UTF-8",
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        for directory in (root / "xdg-config", root / "xdg-cache"):
            directory.mkdir()
        subprocess.run(
            [git, "-c", "init.defaultBranch=pty-smoke", "init", "--quiet", str(project)],
            cwd=project,
            env=env,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )

        first = PtyRun(node, project, env)
        try:
            initial = first.wait_for(b"vesper> ")
            check(f"Project: {project}".encode() in initial, "Vesper did not resolve the canonical temporary project")
            first.assert_raw_prompt()
            check(CURSOR_HIDE not in initial, "Vesper emitted a cursor-hide sequence")
            print("PASS prompt, canonical project, raw input mode, and no cursor-hide sequence")

            first.send(b"What Git branch am I on?\r")
            first.wait_for(b"Current Git branch: pty-smoke")
            prompt_start = len(first.output)
            first.wait_for(b"vesper> ", start=prompt_start)
            check(b"[Codex error" not in first.output, "A local question unexpectedly reached Codex fallback")
            print("PASS ordinary input reached the local handler and returned to the prompt")

            first.resize(42, 11)
            first.send(b":sessions\r")
            first.wait_for(b"Vesper sessions")
            prompt_start = len(first.output)
            first.wait_for(b"vesper> ", start=prompt_start)
            check(first.process.poll() is None, "Vesper exited after a PTY resize")
            print("PASS resize followed by an interactive session command")

            first.send(b"\x03")
            interrupted = first.wait_exit()
            check(CURSOR_HIDE not in interrupted, "Vesper emitted a cursor-hide sequence before interrupt exit")
            session_files = sorted((vesper_home / "sessions").glob("*.json"))
            check(len(session_files) == 1, "The saved Vesper session was missing or duplicated after Ctrl+C")
            session = json.loads(session_files[0].read_text(encoding="utf-8"))
            check(session["cwd"] == str(project.resolve()) and session["threadId"] is None, "The temporary session has unexpected workspace or Codex-thread state")
            print("PASS idle Ctrl+C exits, restores terminal modes, cleans the process group, and preserves the session")
        finally:
            first.close()

        eof = PtyRun(node, project, env)
        try:
            eof.wait_for(b"vesper> ")
            eof.assert_raw_prompt()
            eof.send(b"\x04")
            eof.wait_exit()
            check(len(list((vesper_home / "sessions").glob("*.json"))) == 1, "EOF removed the saved session")
            print("PASS Ctrl+D EOF exits cleanly, restores terminal modes, and preserves the session")
        finally:
            eof.close()

        normal = PtyRun(node, project, env)
        try:
            normal.wait_for(b"vesper> ")
            normal.assert_raw_prompt()
            normal.send(b":quit\r")
            output = normal.wait_exit()
            check(CURSOR_HIDE not in output, "Vesper emitted a cursor-hide sequence before normal exit")
            print("PASS :quit exits cleanly, restores terminal modes, and cleans the process group")
        finally:
            normal.close()

        redirected = subprocess.run(
            [node, str(CLI), str(project)],
            cwd=project,
            env=env,
            input=b"What Git branch am I on?\n:quit\n",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=8,
            check=False,
        )
        combined = redirected.stdout + redirected.stderr
        check(redirected.returncode == 0, f"Redirected CLI exited with {redirected.returncode}")
        check(len(combined) < 16 * 1024, "Redirected output exceeded 16 KiB")
        check(b"\x1b" not in combined, "Redirected output contained an ANSI escape sequence")
        check(b"Current Git branch: pty-smoke" in combined, "Redirected input was not handled by local routing")
        check(b"[Codex error" not in combined, "Redirected local input unexpectedly reached Codex fallback")
        print("PASS redirected stdin/stdout/stderr stays bounded, control-sequence free, and local-only")


if __name__ == "__main__":
    main()

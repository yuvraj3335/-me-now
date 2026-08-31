#!/usr/bin/env python3
"""
A pseudo-terminal, because Bun cannot make one.

Wake's terminal is four processes in a line:

    browser --ws--> Bun --pipes--> THIS --pty--> `tmux attach` --> `claude`

Everything except this file is something Bun or tmux already does well. The one
thing neither can do is hand a child a real controlling terminal. `tmux attach`
refuses to run without a tty ("open terminal failed: not a terminal"), and a TUI
with no tty draws nothing, reports 80x24 forever and never sees a resize — so
the pty is not a detail, it is the whole reason the operator can read the screen.

`node-pty` is the usual answer and it is not usable here: it installs under Bun,
it builds, it spawns — and its read loop never fires, so no byte ever comes back.
Measured on this box, not assumed. This file is nine lines of `pty.fork()` doing
the job that native module could not, and it depends on nothing but CPython's
standard library.

    argv:  cols rows sizefile command [args…]

`sizefile` is how a resize crosses the process boundary. A pty's size is set with
an ioctl on the master fd, which only this process holds; the browser's new size
arrives at Bun. Bun writes "cols,rows" into the file and sends SIGWINCH, and the
handler below re-reads it and applies TIOCSWINSZ. A file rather than a pipe
because the signal already carries the *event* — the file only has to hold the
latest value, and a reader that wakes late should see the newest size rather than
a queue of stale ones.

The command is exec'd from an argv list, never through a shell. Nothing that
reaches this script is ever parsed as shell syntax, which is what keeps a
repository path with a space in it a path with a space in it.
"""
import os, sys, pty, fcntl, termios, struct, signal, select, errno


def setsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def main():
    cols = int(sys.argv[1]); rows = int(sys.argv[2]); sizefile = sys.argv[3]
    argv = sys.argv[4:]

    pid, master = pty.fork()
    if pid == 0:
        os.execvp(argv[0], argv)
        os._exit(127)
    # After the fork, so the child is already attached to the slave side and the
    # first thing it measures is the size the browser actually has.
    setsize(master, cols, rows)

    def winch(_s, _f):
        try:
            with open(sizefile) as f:
                c, r = f.read().strip().split(',')
            setsize(master, int(c), int(r))
        except Exception:
            # A half-written file, or one that is not there yet. The next resize
            # carries the same information; refusing to die for it is the point.
            pass

    signal.signal(signal.SIGWINCH, winch)

    fdin = sys.stdin.fileno(); fdout = sys.stdout.fileno()
    # Non-blocking on the master only. A TUI writes in bursts far larger than one
    # read, and a blocking read here would hold the loop past the next SIGWINCH.
    os.set_blocking(master, False)

    # Watched, rather than a fixed pair, so stdin can be dropped on EOF. A closed
    # fd is *permanently readable* to select(), so leaving it in the set after
    # the browser goes away turns this loop into a spin at 100% of a core — with
    # nothing on screen to say so, because the pty half keeps working.
    watch = [master, fdin]

    while True:
        try:
            r, _, _ = select.select(watch, [], [])
        except InterruptedError:
            # SIGWINCH landed mid-select. That is the normal case, not an error:
            # the handler has already resized, so go round again.
            continue
        except OSError as e:
            if e.errno == errno.EINTR:
                continue
            break

        if master in r:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            # EOF on the master means the child is gone. Exiting here is what
            # lets Bun report `{"t":"exit"}` rather than hold a dead socket open.
            if not data:
                break
            os.write(fdout, data)

        if fdin in r:
            try:
                data = os.read(fdin, 65536)
            except OSError:
                data = b''
            # Bun closing its end of stdin is not a reason to kill the child —
            # the tmux session is meant to outlive every browser attached to it.
            # Stop watching stdin and keep relaying output until the child ends.
            if not data:
                watch = [master]
                continue
            os.write(master, data)

    try:
        os.waitpid(pid, 0)
    except Exception:
        pass


main()

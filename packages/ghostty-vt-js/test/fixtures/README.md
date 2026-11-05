# Test fixtures

## rex-terminal-stream.bin

The stream bytes of one Rex `rex.data.terminal.v1` data connection, recorded after the WELCOME
(1,501 bytes). Rex `0.0.1793741575-g1b6654`, recorded 2026-11-05 on a throwaway Rex server with a
60 × 12 bash pane that ran `printf "\033[1;32mwisp-ok\033[0m %s\n" $((6*7)); echo line-two`
before the stream opened and `echo after-stream-start` after it.

Layout, as documented by the Rex server at `/llms.txt` ("The Terminal Stream"):

1. bytes 0–1268: a Ghostty snapshot (`GHOSTSNP`, format version 1) of the pane;
2. a Rex message `ESC _ rex1;<nonce>;{"type":"resize",...} ESC \`;
3. the program's live output.

The snapshot ends at its FINISH record. Bytes after it are not part of the snapshot.

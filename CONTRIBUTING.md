# Contributing

Thanks for helping! Everything is welcome: reports of other washer models, bug reports, fixes,
translations, documentation.

Questions ("does it work with my washer?", "how do I…?") go to
[Discussions](https://github.com/McArhony/smartthings-samsung-drc-washer/discussions); issues are for
washer model reports and bugs.

## Report your washer model (most useful)

Only the WW10H9400EW has been checked. If you have another Samsung "Smart Control" washer, open
an issue with the **"My washer model"** template and paste:

- the model number (sticker inside the door or on the back);
- the output of `node bin/cli.js test <ip>` and, if pairing worked, `node bin/cli.js status <ip> --raw`
  (it reads only; the washer's MAC-based identifier is hidden automatically);
- for 2878 washers: the programme names shown on its screen, in order.

**Never paste your token, `token.lua`, or the files of `smartthings-edge/src/secrets/`.**

## Code

- Node.js tool and Homebridge plugin: `index.js`, `lib/`, `bin/`, no dependencies; tests:
  `npm test` (simulated 2878 and 8888 washers in `test/`).
- SmartThings Edge driver (Lua): `smartthings-edge/`; tests:
  `lua smartthings-edge/test/test_drc.lua && lua smartthings-edge/test/test_course.lua`.
- Protocol notes: [docs/protocol.md](docs/protocol.md); project status: [HANDOVER.md](HANDOVER.md).

Workflow: fork the repository, create a branch, make your change with tests when possible, open a
pull request describing what you tested (simulated washer or real model).

Rules of the house:

- **No private data in commits**: tokens, keys, certificates, device or location IDs, home IP
  addresses (use `192.168.1.50` in examples).
- Do not commit Samsung's AC14K_M certificate or key.
- Never send a command that starts a washer without someone in front of it.
- Keep messages and documentation in English; translations of the SmartThings labels live in
  `smartthings-edge/capabilities/build.py`.

By contributing, you agree that your contribution is published under the MIT licence of this
repository.

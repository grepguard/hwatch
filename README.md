# HWatch

HWatch is a small CLI for hardware health intelligence for servers and racks.

## Requirements

- Node.js 22.13 or newer

## Install

```sh
npm install -g hwatchjs
```

## Usage

Start collecting a sample every five seconds:

```sh
hwatch start
```

Choose another interval in seconds:

```sh
hwatch start --interval 10
```

See the current system readings and collector state:

```sh
hwatch status
```

Refresh the status view until you press Ctrl+C:

```sh
hwatch status --watch
```

Stop background sampling:

```sh
hwatch stop
```

View recent saved samples:

```sh
hwatch history
hwatch history --since 6h --limit 50
```

> **_Note:_** HWatch currently supports macOS and Linux only.

> **_Note:_** Sensor availability depends on the operating system, kernel, and hardware; macOS does not expose temperatures through this first version.

> **_Note:_** The collector stores data in `~/.hwatch/hwatch.sqlite`, keeps the most recent seven days, and writes no data outside the local machine. Set `HWATCH_DATA_DIR` to change the state directory.

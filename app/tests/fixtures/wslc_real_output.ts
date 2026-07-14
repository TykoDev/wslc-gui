// REAL outputs captured live from wslc 2.9.3.0 on 2026-07-13 (Win10 19045,
// WSL pre-release). These are evidence-grade fixtures: if wslc changes format,
// update these from live output — never invent entries.

export const WSLC_VERSION_LINE = "wslc 2.9.3.0";

export const WSLC_TOP_HELP = `Copyright (c) Microsoft Corporation. All rights reserved.
For privacy information about this product please visit https://aka.ms/privacy.

WSLC is the Windows Subsystem for Linux Container CLI tool. It enables management and interaction with WSL containers from the command line.

Usage: wslc  [<command>] [<options>]

The following commands are available:
  container  Manage containers.
  image      Manage images.
  network    Manage networks.
  registry   Manage registry credentials.
  settings   Open the settings file in the default editor.
  system     System-level commands
  volume     Manage volumes.
  attach     Attach to a container.
  build      Build an image from a Dockerfile.
  create     Create a container.
  exec       Execute a command in a running container.
  export     Export a container's filesystem as a tar archive.
  images     List images.
  import     Import an image from a tarball.
  inspect    Inspect objects.
  kill       Kill containers.
  list       List containers.
  load       Load images.
  login      Log in to a registry.
  logout     Log out from a registry.
  logs       View container logs.
  pull       Pull images.
  push       Upload an image to a registry.
  remove     Remove containers.
  rmi        Remove images.
  run        Run a container.
  save       Save images.
  start      Start a container.
  stats      Display container resource usage statistics.
  stop       Stop containers.
  tag        Tag an image.
  version    Show version information.

For more details on a specific command, pass it the help argument. [-?]

The following options are available:
  -v,--version  Show version information for this tool
  -?,--help     Shows help about the selected command`;

export const WSLC_CONTAINER_HELP = `Copyright (c) Microsoft Corporation. All rights reserved.
For privacy information about this product please visit https://aka.ms/privacy.

Manage the lifecycle of WSL containers, including creating, starting, stopping, and removing them.

Usage: wslc container [<command>] [<options>]

The following sub-commands are available:
  attach   Attach to a container.
  create   Create a container.
  exec     Execute a command in a running container.
  export   Export a container's filesystem as a tar archive.
  inspect  Inspect a container.
  kill     Kill containers.
  logs     View container logs.
  list     List containers.
  prune    Remove all stopped containers.
  remove   Remove containers.
  run      Run a container.
  start    Start a container.
  stats    Display container resource usage statistics.
  stop     Stop containers.

For more details on a specific command, pass it the help argument. [-?]`;

export const WSLC_IMAGE_HELP = `Copyright (c) Microsoft Corporation. All rights reserved.
For privacy information about this product please visit https://aka.ms/privacy.

Manage container images, including building, pulling, listing, and removing them.

Usage: wslc image [<command>] [<options>]

The following sub-commands are available:
  build    Build an image from a Dockerfile.
  remove   Remove images.
  inspect  Inspect images.
  list     List images.
  load     Load images.
  import   Import an image from a tarball.
  prune    Remove unused images.
  pull     Pull images.
  push     Upload an image to a registry.
  save     Save images.
  tag      Tag an image.

For more details on a specific command, pass it the help argument. [-?]`;

export const WSLC_VOLUME_HELP = `Copyright (c) Microsoft Corporation. All rights reserved.
For privacy information about this product please visit https://aka.ms/privacy.

Manage the lifecycle of WSL volumes, including creating, inspecting, listing, and deleting them.

Usage: wslc volume [<command>] [<options>]

The following sub-commands are available:
  create   Create a volume.
  remove   Remove one or more volumes.
  inspect  Display detailed information on one or more volumes.
  list     List volumes.
  prune    Remove unused local volumes.

For more details on a specific command, pass it the help argument. [-?]

The following options are available:
  -?,--help  Shows help about the selected command`;

/** `wslc volume list --format json` — live 2026-07-13. NOTE the shape: Driver and Name
 * and NOTHING else. No CreatedAt, no Labels, no size, no mountpoint. Anything richer has
 * to come from `volume inspect`; nothing may be invented to fill the gap. */
export const WSLC_VOLUME_LIST_JSON = `[
  {
    "Driver": "guest",
    "Name": "60e1ab6c49daa80ebb6177869fafaf29e72024fa15ed5f3cf1242ced703648ba"
  },
  {
    "Driver": "guest",
    "Name": "r9probe-named"
  }
]`;

export const WSLC_VOLUME_LIST_EMPTY_JSON = `[]`;

/** `wslc volume inspect <anon> <named>` — live 2026-07-13. Several names in ONE call.
 * `Status` is null and there is NO Size and NO Mountpoint field (probe P3). The anonymous
 * volume is identified purely by the label docker/wslc stamps on it. */
export const WSLC_VOLUME_INSPECT_JSON = `[
  {
    "CreatedAt": "2026-07-13T03:32:26Z",
    "Driver": "guest",
    "DriverOpts": {},
    "Labels": {
      "com.docker.volume.anonymous": ""
    },
    "Name": "60e1ab6c49daa80ebb6177869fafaf29e72024fa15ed5f3cf1242ced703648ba",
    "Status": null
  },
  {
    "CreatedAt": "2026-07-13T20:39:05Z",
    "Driver": "guest",
    "DriverOpts": {},
    "Labels": {},
    "Name": "r9probe-named",
    "Status": null
  }
]`;

/** A name that does not exist: wslc prints the miss AND an empty array, exit 1. */
export const WSLC_VOLUME_INSPECT_MISSING = `Volume not found: 'no-such-volume-xyz'
[]`;

/** `wslc volume prune` — live 2026-07-13. It reclaimed the orphaned ANONYMOUS volume and
 * left both the named one and the anonymous volume of an exited-but-still-present
 * container alone. wslc reports the reclaimed total itself; we pass it through. */
export const WSLC_VOLUME_PRUNE = `Deleted: 0afb8c734624ce9f6602c2449873ea65359d1d81862037b206a93eda5cbf4000

Total reclaimed space: 0 B`;

export const WSLC_RUN_HELP = `Runs a container. By default, the container is started in the foreground; use --detach to run in the background.

Usage: wslc run [<options>] <image> [<command>] [<arguments>...]

The following options are available:
  --cidfile         Write the container ID to the provided path
  --cpus            Number of CPUs (e.g. 0.5, 1, 2.5)
  -d,--detach       Run container in detached mode
  --dns             IP address of the DNS nameserver in resolv.conf
  --entrypoint      Specifies the container init process executable
  -e,--env          Key=Value pairs for environment variables
  --env-file        File containing key=value pairs of env variables
  --gpus            Add GPU devices to the container ('all' to pass all GPUs)
  -i,--interactive  Attach to stdin and keep it open
  -l,--label        Set metadata on an object
  -m,--memory       Memory limit (e.g. 512M, 1G)
  --name            Name of the container
  --network         Connect a container to a network
  -p,--publish      Publish a port from a container to host
  -P,--publish-all  Publish all exposed ports to random host ports
  --rm              Remove the container after it stops
  -t,--tty          Open a TTY with the container process.
  -u,--user         User ID for the process (name|uid|uid:gid)
  -v,--volume       Bind mount a volume to the container
  -w,--workdir      Working directory inside the container
  -?,--help         Shows help about the selected command`;

export const WSLC_CONTAINER_LIST_RUNNING = `CONTAINER ID   NAME   IMAGE   CREATED          STATUS                   PORTS
2cd4a4f3024d   web    nginx   25 seconds ago   running 3 seconds ago    127.0.0.1:8080->80/tcp`;

export const WSLC_CONTAINER_LIST_EMPTY = `CONTAINER ID   NAME   IMAGE   CREATED   STATUS   PORTS`;

export const WSLC_IMAGE_LIST = `REPOSITORY    TAG      IMAGE ID       CREATED        SIZE
hello-world   latest   e2ac70e7319a   3 months ago   0.01 MB
nginx         latest   1e5f3c5b981a   2 weeks ago    72.99 MB`;

export const WSLC_SESSION_LIST = `ID   Creator PID   Display Name
1    12308         wslc-cli-user`;

export const WSL_LIST_ONLINE = `The following is a list of valid distributions that can be installed.
Install using 'wsl.exe --install <Distro>'.

NAME                            FRIENDLY NAME
Ubuntu                          Ubuntu
Ubuntu-26.04                    Ubuntu 26.04 LTS
Ubuntu-24.04                    Ubuntu 24.04 LTS
openSUSE-Tumbleweed             openSUSE Tumbleweed
SUSE-Linux-Enterprise-15-SP7    SUSE Linux Enterprise 15 SP7`;

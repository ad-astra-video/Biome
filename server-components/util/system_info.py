"""
Server system/runtime introspection.

`SystemMonitor` is the one-stop access point: a snapshot of static hardware
identity queried once at startup (CPU/GPU/driver/etc.), live samplers (VRAM,
GPU util) for frame-header metrics, and an error-snapshot builder used when
constructing `error` push messages.

One instance per process — constructed at startup in `main.py` and threaded
through to consumers (no module globals). The wire-typed `SystemInfo` and
`ErrorSnapshot` Pydantic models live in `protocol.py`; this module produces
and consumes them directly. Anything device-specific routes through
`engine.devices` so the rest of the codebase stays backend-agnostic.
"""

# pyright: reportMissingTypeStubs=none

import importlib.metadata
import json
import re
from typing import cast

import cpuinfo
import psutil
import structlog
import torch

from engine import devices
from server.protocol import ErrorSnapshot, PackageVersion, SystemInfo

logger = structlog.stdlib.get_logger(__name__)

# A 40-char hex blob embedded in a GitHub `/archive/<sha>.zip` URL —
# uv records exactly that string in `direct_url.json` when the dependency
# was pinned to a commit-archive rather than a tag or a real VCS source.
_GITHUB_ARCHIVE_COMMIT_RE = re.compile(r"/archive/(?:refs/heads/[^/]+/)?([0-9a-f]{40})\.zip", re.IGNORECASE)


def _resolve_package_version(distribution_name: str) -> PackageVersion | None:
    """Inspect the installed distribution and return `(version, short commit)`.

    Reads `direct_url.json` (PEP 610) to recover the commit hash when uv
    installed the package from a git source or a `/archive/<sha>.zip` URL.
    Falls back to just the distribution version when no source info is
    available; returns `None` if the package isn't installed at all so the
    caller can keep going (a missing optional backend isn't fatal)."""
    try:
        dist = importlib.metadata.distribution(distribution_name)
    except importlib.metadata.PackageNotFoundError:
        return None

    commit = _extract_commit_from_direct_url(dist.read_text("direct_url.json"), distribution_name)
    return PackageVersion(version=dist.version, commit=commit)


def _extract_commit_from_direct_url(direct_url_text: str | None, distribution_name: str) -> str | None:
    """Parse a PEP 610 `direct_url.json` blob and return a short commit hash.

    Two shapes are handled: a `vcs_info.commit_id` (set when uv installed
    the package from a git source) and a `/archive/<40-hex>.zip` GitHub
    URL (set when the dep is pinned to a commit-archive). Tag archives
    like `/archive/refs/tags/1.5.6.zip` don't carry a SHA — those return
    `None` and the caller relies on the distribution version instead."""
    if not direct_url_text:
        return None
    try:
        parsed = json.loads(direct_url_text)
    except json.JSONDecodeError as e:
        logger.warning(f"Failed to parse direct_url.json for {distribution_name}: {e}")
        return None
    if not isinstance(parsed, dict):
        return None
    direct_url = cast("dict[str, object]", parsed)

    vcs_info = direct_url.get("vcs_info")
    if isinstance(vcs_info, dict):
        commit_id = cast("dict[str, object]", vcs_info).get("commit_id")
        if isinstance(commit_id, str) and len(commit_id) >= 7:
            return commit_id[:7]

    url = direct_url.get("url")
    if isinstance(url, str):
        match = _GITHUB_ARCHIVE_COMMIT_RE.search(url)
        if match:
            return match.group(1)[:7]
    return None


def _collect_system_info() -> tuple[SystemInfo, devices.NvmlHandle | None]:
    """Query CPU / device / NVML once at startup. Returns the static info plus
    the opaque NVML handle (or `None` if NVML init failed). Each subsystem is
    wrapped so a failure in one doesn't prevent the others from populating."""
    cpu_name: str | None = None

    try:
        cpu_name = cpuinfo.get_cpu_info().get("brand_raw") or None
    except Exception as e:  # noqa: BLE001  -- py-cpuinfo can raise OSError/RuntimeError/etc. depending on platform; soft-fail and keep going
        logger.warning(f"Failed to query CPU info: {e}")

    try:
        gpu_count = devices.device_count()
        gpu_name = devices.device_name(0)
        vram_total_bytes = devices.total_memory(0)
        runtime_version = devices.runtime_version()
    except Exception as e:  # noqa: BLE001  -- torch/device wrappers can raise a grab-bag depending on backend; soft-fail and keep going
        logger.warning(f"Failed to query device info: {e}")
        gpu_count = 0
        gpu_name = None
        vram_total_bytes = None
        runtime_version = None

    nvml_handle = devices.open_nvml_handle()
    driver_version = devices.driver_version_via_nvml() if nvml_handle is not None else None

    info = SystemInfo(
        cpu_name=cpu_name,
        gpu_name=gpu_name,
        vram_total_bytes=vram_total_bytes,
        runtime_version=runtime_version,
        driver_version=driver_version,
        torch_version=torch.__version__,
        gpu_count=gpu_count,
        world_engine=_resolve_package_version("world-engine"),
        quark=_resolve_package_version("quark"),
    )
    return info, nvml_handle


def _format_package(pkg: PackageVersion | None) -> str:
    if pkg is None:
        return "[unavailable]"
    parts = [p for p in (pkg.version, pkg.commit) if p]
    return "-".join(parts) if parts else "[unavailable]"


def _log_system_info(info: SystemInfo) -> None:
    """Log the static system info. Called once at startup so server.log has
    hardware context above any later errors (Overworldai/Biome#98)."""
    gpu_name = info.gpu_name or "[unknown]"
    gpu_count = info.gpu_count
    gpu_summary = f"{gpu_name} (x{gpu_count})" if gpu_count > 1 else gpu_name
    vram_str = f", {info.vram_total_bytes // (1024 * 1024)} MB VRAM" if info.vram_total_bytes else ""
    logger.info("System info:")
    logger.info(f"  CPU:     {info.cpu_name or '[unknown]'}")
    logger.info(f"  GPU:     {gpu_summary}{vram_str}")
    logger.info(f"  Runtime: {info.runtime_version or '[unavailable]'}")
    logger.info(f"  Driver:  {info.driver_version or '[unknown]'}")
    logger.info(f"  Torch:   {info.torch_version}")
    logger.info(f"  WEngn:   {_format_package(info.world_engine)}")
    logger.info(f"  Quark:   {_format_package(info.quark)}")


class SystemMonitor:
    """Static hardware identity + live samplers + error-state snapshots.

    One instance per process; pass it down to consumers explicitly. The
    static `info` is collected once at construction and never changes.
    Sampler methods (`vram_used_bytes`, `gpu_util_percent`,
    `capture_error_snapshot`) re-query each call."""

    info: SystemInfo

    def __init__(self, info: SystemInfo, nvml_handle: devices.NvmlHandle | None) -> None:
        self.info = info
        self._nvml_handle = nvml_handle

    @classmethod
    def collect(cls) -> "SystemMonitor":
        """Query the host once and log the result. Call exactly once at
        process startup; the returned instance is the canonical handle for
        the rest of the process."""
        info, nvml_handle = _collect_system_info()
        _log_system_info(info)
        return cls(info=info, nvml_handle=nvml_handle)

    # ─── Live samplers ────────────────────────────────────────────────

    def gpu_util_percent(self) -> int:
        """Current GPU utilization (0-100), or -1 if unavailable. Prefers
        torch's fast path; falls back to NVML which talks to the same driver
        as nvidia-smi."""
        u = devices.utilization_via_torch()
        if u >= 0:
            return u
        if self._nvml_handle is not None:
            return devices.utilization_via_nvml(self._nvml_handle)
        return -1

    def vram_used_bytes(self) -> int:
        """VRAM allocated by torch on device 0, in bytes. -1 if unavailable."""
        return devices.memory_allocated()

    def vram_reserved_bytes(self) -> int:
        """VRAM held by torch's allocator (allocated + cached), in bytes.
        -1 if unavailable."""
        return devices.memory_reserved()

    # ─── Error snapshot ──────────────────────────────────────────────

    def capture_error_snapshot(self) -> ErrorSnapshot:
        """Best-effort snapshot of ephemeral state at the moment of an error.

        Attached to outgoing error push messages so bug reports include what
        the server was actually doing at failure time, not the idle state
        recorded when the user later clicks "Copy Report"."""
        process_rss_bytes: int | None = None
        ram_used_bytes: int | None = None
        ram_total_bytes: int | None = None

        try:
            process = psutil.Process()
            process_rss_bytes = process.memory_info().rss
            vm = psutil.virtual_memory()
            ram_used_bytes = vm.total - vm.available
            ram_total_bytes = vm.total
        except (OSError, psutil.Error):
            pass

        vram_used = self.vram_used_bytes()
        vram_reserved = self.vram_reserved_bytes()
        util = self.gpu_util_percent()

        return ErrorSnapshot(
            process_rss_bytes=process_rss_bytes,
            ram_used_bytes=ram_used_bytes,
            ram_total_bytes=ram_total_bytes,
            vram_used_bytes=vram_used if vram_used >= 0 else None,
            vram_reserved_bytes=vram_reserved if vram_reserved >= 0 else None,
            gpu_util_percent=util if util >= 0 else None,
        )

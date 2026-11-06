from __future__ import annotations

import json
import math
import sys
import time
from typing import Any

import voicemeeterlib

ROUTES = (
    "A1", "A2", "A3", "A4", "A5",
    "B1", "B2", "B3",
)

FLAGS = ("mute", "solo", "mono")
STRIP_COUNT = 8
PHYSICAL_STRIPS = 5
MIN_GAIN = -60.0
MAX_GAIN = 12.0
WRITE_DELAY = 0.08


def log(message: str) -> None:
    print(f"[bridge] {message}", file=sys.stderr, flush=True)


def respond(request_id: Any, **payload: Any) -> None:
    print(
        json.dumps(
            {"id": request_id, **payload},
            ensure_ascii=False,
            allow_nan=False,
        ),
        flush=True,
    )


def validate_strip(value: Any) -> int:
    if type(value) is not int:
        raise ValueError("Strip index must be an integer")

    if not 0 <= value < STRIP_COUNT:
        raise ValueError("Strip index must be between 0 and 7")

    return value


def validate_step(value: Any) -> float:
    if type(value) not in (int, float):
        raise ValueError("Gain step must be numeric")

    step = float(value)

    if not math.isfinite(step) or not 0 < step <= 12:
        raise ValueError("Gain step must be greater than 0 and <= 12")

    return step


def param(index: int, field: str) -> str:
    if field == "mono" and index >= PHYSICAL_STRIPS:
        field = "MC"

    return f"Strip[{index}].{field}"


def read_number(vm: Any, index: int, field: str) -> float:
    value = float(vm.get(param(index, field)))

    if not math.isfinite(value):
        raise ValueError(f"Non-finite value for {field}")

    return value


def read_flag(vm: Any, index: int, field: str) -> bool:
    return read_number(vm, index, field) >= 0.5


def write_flag(
    vm: Any,
    index: int,
    field: str,
    value: bool,
) -> None:
    parameter = param(index, field)
    vm.set(parameter, 1.0 if value else 0.0)

    time.sleep(WRITE_DELAY)

    actual = read_flag(vm, index, field)

    log(
        f"{parameter}: requested={int(value)} "
        f"readback={int(actual)}"
    )

    if actual != value:
        raise RuntimeError(
            f"{parameter} did not reach the requested state"
        )


def toggle_flag(vm: Any, index: int, field: str) -> None:
    previous = read_flag(vm, index, field)
    write_flag(vm, index, field, not previous)


def set_gain(
    vm: Any,
    index: int,
    action: str,
    step: float,
) -> None:
    previous = read_number(vm, index, "Gain")
    delta = step if action == "gainup" else -step

    target = round(
        max(MIN_GAIN, min(MAX_GAIN, previous + delta)),
        2,
    )

    vm.set(param(index, "Gain"), target)
    time.sleep(WRITE_DELAY)

    actual = read_number(vm, index, "Gain")

    log(
        f"Strip[{index}].Gain: "
        f"previous={previous:.2f} "
        f"requested={target:.2f} "
        f"readback={actual:.2f}"
    )

    if abs(actual - target) > 0.15:
        raise RuntimeError(
            f"Gain write verification failed: "
            f"requested={target}, actual={actual}"
        )


def snapshot(vm: Any) -> list[dict[str, Any]]:
    result = []

    for index in range(STRIP_COUNT):
        item = {
            "index": index,
            "label": str(
                vm.get(
                    param(index, "Label"),
                    is_string=True,
                )
            ),
            "gain": round(
                read_number(vm, index, "Gain"),
                2,
            ),
            "mute": read_flag(vm, index, "mute"),
            "solo": read_flag(vm, index, "solo"),
            "mono": read_flag(vm, index, "mono"),
            "routes": {
                route: read_flag(vm, index, route)
                for route in ROUTES
            },
        }

        result.append(item)

    return result


def execute(
    vm: Any,
    request: dict[str, Any],
) -> list[dict[str, Any]]:
    operation = request.get("op")

    if operation == "snapshot":
        return snapshot(vm)

    if operation != "command":
        raise ValueError("Unknown operation")

    index = validate_strip(request.get("strip"))
    action = request.get("action")

    if action in ("gainup", "gaindown"):
        step = validate_step(request.get("step", 1.0))
        set_gain(vm, index, action, step)

    elif action in FLAGS:
        toggle_flag(vm, index, action)

    elif action == "route":
        route = request.get("route")

        if not isinstance(route, str) or route not in ROUTES:
            raise ValueError("Invalid routing bus")

        toggle_flag(vm, index, route)

    else:
        raise ValueError("Unknown action")

    return snapshot(vm)


def main() -> int:
    try:
        with voicemeeterlib.api(
            "potato",
            sync=True,
        ) as vm:
            log("Connected to Voicemeeter Potato")

            for line in sys.stdin:
                request_id = None

                try:
                    request = json.loads(line)

                    if not isinstance(request, dict):
                        raise ValueError("Expected JSON object")

                    request_id = request.get("id")
                    data = execute(vm, request)

                    respond(
                        request_id,
                        ok=True,
                        data=data,
                    )

                except Exception as exc:
                    log(f"Request failed: {exc}")

                    respond(
                        request_id,
                        ok=False,
                        error=str(exc),
                    )

    except Exception as exc:
        log(f"Connection failed: {exc}")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Run the fee-first cadCAD allocator.

    python run.py baseline
    python run.py sweep
    python run.py reverse
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from model import default_params, metrics_frame, run_model

HERE = Path(__file__).resolve().parent
SCENARIO = HERE.parent / "allocator" / "data" / "scenario_45d.json"
OUT = HERE / "out"
POOL_FEES_05 = 293_889.20
POOL_FEES_30 = 22_839.59
CAP = 100_000.0


def load_rows(hours: int | None = None) -> list[dict]:
    with open(SCENARIO, "r", encoding="utf-8") as fh:
        rows = json.load(fh)["hours"]
    return rows[-hours:] if hours else rows


def run_case(
    rows: list[dict],
    policy: str = "static",
    p15: float = 0.0,
    p30: float = 0.0,
    vol15: float = 2.0,
    vol30: float = 1.0,
    **overrides,
) -> pd.DataFrame:
    p = default_params()
    p.update(
        {
            "policy": policy,
            "static_weights": {"p05": 1.0 - p15 - p30, "p15": p15, "p30": p30},
            "vol15_mult": vol15,
            "vol30_mult": vol30,
            "horizon_hours": len(rows),
            **overrides,
        }
    )
    return metrics_frame(run_model(rows, p, T=len(rows)))


def baseline() -> None:
    rows = load_rows()
    all_05 = run_case(rows, "all_05")
    base_fee = float(all_05.iloc[-1]["m_fees_total"])
    print(f"all 0.05: fees {base_fee:,.2f} net_after_il {float(all_05.iloc[-1]['m_net_after_il']):+,.2f}")
    for label, kwargs in (
        ("all 0.15 @1x", {"policy": "all_15", "vol15": 1.0}),
        ("all 0.15 @2x", {"policy": "all_15", "vol15": 2.0}),
        ("all 0.30", {"policy": "all_30"}),
        ("15% 0.15", {"p15": 0.15}),
        ("30% 0.30", {"p30": 0.30}),
        ("15% each", {"p15": 0.15, "p30": 0.15}),
        ("fee_check 1.0x", {"policy": "fee_check", "vol30": 1.0}),
        ("fee_check 1.5x", {"policy": "fee_check", "vol30": 1.5}),
        ("fee_check 2.0x", {"policy": "fee_check", "vol30": 2.0}),
        ("fee_check 10x", {"policy": "fee_check", "vol30": 10.0}),
    ):
        mf = run_case(rows, **kwargs)
        last = mf.iloc[-1]
        moved = float(last["m_weights_p15"]) + float(last["m_weights_p30"])
        gain = float(last["m_fees_total"]) - base_fee
        print(
            f"{label:14s} fees {float(last['m_fees_total']):9,.2f}"
            f" net_after_il {float(last['m_net_after_il']):+10,.2f}"
            f" fee_gain {gain:+10,.2f}"
            f" risk_gain {gain - moved*1_696.47:+10,.2f}"
            f" w15 {float(last['m_weights_p15'])*100:5.1f}%"
            f" w30 {float(last['m_weights_p30'])*100:5.1f}%"
        )


def sweep() -> None:
    rows = load_rows()
    all_05 = run_case(rows, "all_05")
    base_fee = float(all_05.iloc[-1]["m_fees_total"])
    records = []
    for p15 in (0.0, 0.05, 0.10, 0.15, 0.20, 0.30):
        for p30 in (0.0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.28, 0.30, 0.45):
            if p15 + p30 > 1.0:
                continue
            for vol30 in (1.0, 1.25, 1.5, 2.0, 3.0, 5.0):
                for vol15 in (1.0, 2.0, 5.0):
                    mf = run_case(rows, p15=p15, p30=p30, vol15=vol15, vol30=vol30)
                    last = mf.iloc[-1]
                    records.append(
                        {
                            "p15": p15,
                            "p30": p30,
                            "vol15": vol15,
                            "vol30": vol30,
                            "fees_total": float(last["m_fees_total"]),
                            "fees_05": float(last["m_fees.p05"]),
                            "fees_15": float(last["m_fees.p15"]),
                            "fees_30": float(last["m_fees.p30"]),
                            "net_after_il": float(last["m_net_after_il"]),
                            "gain_vs_05": float(last["m_fees_total"]) - base_fee,
                            "gain_vs_risk": float(last["m_fees_total"]) - base_fee - (p15 + p30) * 1_696.47,
                            "w15": float(last["m_weights_p15"]),
                            "w30": float(last["m_weights_p30"]),
                        }
                    )
    df = pd.DataFrame(records)
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT / "sweep.csv", index=False)
    print(f"wrote {OUT / 'sweep.csv'} ({len(df)} cases)")


def time_split() -> None:
    rows = load_rows()
    risk_path = HERE.parent / "allocator" / "out" / "recommended_100k_path.csv"
    risk = pd.read_csv(risk_path)
    risk_arm = risk["mode"].eq("ARMS").to_numpy()
    n = len(risk_arm)
    records = []
    for vol in (1.0, 1.5, 2.0, 10.0):
        mf = run_case(rows, policy="fee_check", vol30=vol, vol15=2.0)
        w30 = mf["m_weights_p30"].to_numpy()
        states = []
        for i in range(n):
            if risk_arm[i]:
                states.append("ARM")
            elif w30[i] > 1e-9:
                states.append("0.30")
            else:
                states.append("0.05")
        counts = pd.Series(states).value_counts()
        cap30 = float((w30 * (~risk_arm)).sum() / n)
        cap05 = float(((1.0 - w30) * (~risk_arm)).sum() / n)
        cap_arm = float(risk_arm.mean())
        records.append(
            {
                "vol30": vol,
                "end_w30": float(w30[-1]),
                "any_30_exposure": float((w30 > 1e-9).mean()),
                "hours_arm": int(counts.get("ARM", 0)),
                "hours_30": int(counts.get("0.30", 0)),
                "hours_05": int(counts.get("0.05", 0)),
                "pct_arm": float(counts.get("ARM", 0) / n),
                "pct_30": float(counts.get("0.30", 0) / n),
                "pct_05": float(counts.get("0.05", 0) / n),
                "capital_arm": cap_arm,
                "capital_30": cap30,
                "capital_05": cap05,
            }
        )
    out = pd.DataFrame(records)
    OUT.mkdir(parents=True, exist_ok=True)
    out.to_csv(OUT / "time_split.csv", index=False)
    print(out.to_string(index=False))


def reverse() -> None:
    rows = load_rows()
    all_05 = run_case(rows, "all_05")
    base_fee = float(all_05.iloc[-1]["m_fees_total"])
    records = []
    for p15 in (0.15, 0.30):
        for p30 in (0.15, 0.30):
            for vol30 in (1.0, 1.5, 2.0):
                mf = run_case(rows, p15=p15, p30=p30, vol15=2.0, vol30=vol30)
                last = mf.iloc[-1]
                fees_i = float(last["m_fees.p30"]) if p30 else 0.0
                if p30 <= 0 or fees_i <= 0:
                    continue
                other = float(last["m_fees_total"]) - fees_i
                for margin in (0.0, 250.0, 500.0):
                    required_fee = base_fee + margin + (p15 + p30) * 1_696.47 - other
                    mult = required_fee / fees_i
                    records.append(
                        {
                            "p15": p15,
                            "p30": p30,
                            "vol30": vol30,
                            "margin": margin,
                            "current_fee_30": fees_i,
                            "required_volume_mult": mult,
                            "already": mult <= 1.0,
                        }
                    )
    out = pd.DataFrame(records)
    OUT.mkdir(parents=True, exist_ok=True)
    out.to_csv(OUT / "reverse.csv", index=False)
    print(out.to_string(index=False))


if __name__ == "__main__":
    import sys

    cmd = sys.argv[1] if len(sys.argv) > 1 else "baseline"
    if cmd == "baseline":
        baseline()
    elif cmd == "sweep":
        sweep()
    elif cmd == "reverse":
        reverse()
    elif cmd == "time":
        time_split()
    else:
        raise SystemExit(f"unknown command {cmd}")

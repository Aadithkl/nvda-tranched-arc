import json
from pathlib import Path

import pytest

import build_dashboard
import build_scenario_dashboard
import build_scenario_lab

HERE = Path(__file__).resolve().parents[1]
OUT = HERE / "out"


def test_dashboard_builds():
    required = [
        OUT / "baseline_summary.csv",
        OUT / "baseline_paths.csv",
        OUT / "sweep_summary.csv",
        OUT / "mc_summary.json",
        OUT / "eth_compare.json",
    ]
    if not all(p.exists() for p in required):
        pytest.skip("dashboard inputs not built")
    build_dashboard.main()
    html = (OUT / "dashboard.html").read_text(encoding="utf-8")
    for needle in (
        "NVDA allocator — simulation dashboard",
        "ETH/NVDA vs USDG/NVDA",
        "ETH/USD breakeven",
        "A: 2h/15k/75",
        "Rewards: book vs arm",
        "Inventory, swaps, and re-centering",
        "Monte Carlo: in-sample best vs always-A",
        "data-eth=\"1\"",
        "updateEth",
    ):
        assert needle in html


def test_scenario_dashboard_builds():
    required = [
        OUT / "baseline_summary.csv",
        OUT / "baseline_paths.csv",
        OUT / "optimize_summary.csv",
        OUT / "optimize_paths.csv",
        OUT / "large_nav_summary.csv",
        OUT / "optimize_mc.json",
    ]
    if not all(p.exists() for p in required):
        pytest.skip("scenario dashboard inputs not built")
    build_scenario_dashboard.main()
    html = (OUT / "scenario_dashboard.html").read_text(encoding="utf-8")
    for needle in (
        "Every single pool over the 45 days",
        "Book A vs Book B vs the arm",
        "Where the money comes from",
        "Recommended C skew 1k",
        "Does it scale?",
        "Risk check",
        "Why the model is credible",
        "76 passed",
    ):
        assert needle in html


def test_scenario_lab_builds():
    data_path = OUT / "scenario_lab_data.json"
    if not data_path.exists():
        pytest.skip("scenario lab data not collected")
    data = json.loads(data_path.read_text(encoding="utf-8"))
    build_scenario_lab.build_html(data)
    html = (OUT / "scenario_lab.html").read_text(encoding="utf-8")
    for needle in (
        "Market scenarios",
        "Strategy lab",
        "Scaling",
        "Single pools",
        "Book + arm",
        "Risk &amp; validation",
        "Volume 2×",
        "Recommended C skew 1k",
        "Pool-level sensitivity",
        "76 passed",
    ):
        assert needle in html

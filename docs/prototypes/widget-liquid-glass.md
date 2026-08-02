# Liquid-glass widget prototype

> Prototype only. This branch answers: **which transparent, Windows-native layout should replace the current widget surface?**

Run the deterministic visual comparison with one command:

```powershell
py widget_liquid_glass_prototype.py --demo
```

Use the on-widget arrows or the keyboard `Left` / `Right` keys to compare:

- **A — Frosted Stack:** spend-first vertical hierarchy, detailed quota rows, compact reset horizon.
- **B — Prism Grid:** quota-first two-column tiles, with token spend as the sixth tile.
- **C — Clear Lens Dock:** transparent horizontal dock for the fastest glance.

The current selection can also be opened directly:

```powershell
py widget_liquid_glass_prototype.py --demo --variant B
```

Omit `--demo` to read live quotas and local token spend from the running LLM Quota server. A custom local server remains supported:

```powershell
py widget_liquid_glass_prototype.py --server-url http://localhost:8080
```

The prototype uses the native Windows acrylic composition API when available and falls back to whole-window alpha transparency. Drag anywhere on the glass surface to reposition it; press `Esc` or right-click to close it.

Once one direction wins, only that decision should be rewritten into `widget.py`; this comparison harness stays on the prototype branch.

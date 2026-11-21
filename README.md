# Suspension-Calculator
Calculates optimal suspension geometry based off of supplied information.

- Project plan and conventions: [GOALS.md](GOALS.md)
- Math specification: [docs/MATH.md](docs/MATH.md)

## Development

Requires [Node.js](https://nodejs.org/) 20+.

```sh
npm install
npm test                  # run the test suite
npm run typecheck         # TypeScript type check
npm run compare:layouts   # print camber / roll center for the sample layouts
```

## Layout

| Path | Contents |
|---|---|
| `src/core/math` | L0 geometry: vectors, rotations, planes/lines, linear algebra |
| `src/core/solver` | Generic rigid-body constraint system (relations, not a chain) |
| `src/core/suspension` | Double wishbone kinematics and characteristics |
| `src/examples` | Sample geometries |
| `scripts` | Command-line analysis scripts |
| `tests` | Vitest tests |
| `References` | Author's conceptual hand math and process notes |

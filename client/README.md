# BetStan client

React single-page app built with Create React App (`react-scripts`). Product
behavior and design guidance live in the public wiki pages
[User Interface](../docs/wiki/User-Interface.md) and
[UI/UX Consistency](../docs/wiki/UI-UX-Consistency.md).

## Commands

Run from `client/`:

| Command | Purpose |
| --- | --- |
| `npm start` | Development server on <http://localhost:3000> |
| `npm test` | Jest unit tests in watch mode (`CI=true npm test` runs once) |
| `npm run build` | Production bundle in `build/` |
| `npm run test:e2e` | Playwright end-to-end tests (`test:e2e:headed` shows the browser) |

Do not run `npm run eject`; the build depends on the managed `react-scripts`
configuration. See the [Create React App docs](https://create-react-app.dev/)
for tooling details.

## Summary

- What changed?
- Why is this change needed?

## Scope

- [ ] Native server
- [ ] Chrome extension
- [ ] Shared package
- [ ] Docs only
- [ ] Build / release / repo metadata

## Validation

List the exact commands you ran, or explain why no local validation was needed.

```powershell
# example
pnpm --filter aieasybrowser-bridge exec jest src/mcp/mcp-server.test.ts --runInBand --coverage=false
pnpm --filter aieasybrowser-bridge exec tsc --noEmit
```

## Compatibility / risk

- Any behavior change?
- Any client compatibility impact?
- Any follow-up work needed?

## Checklist

- [ ] I checked the changed files only; no unrelated changes were included
- [ ] I updated docs if behavior or configuration changed
- [ ] I added or updated tests when the change affects behavior
- [ ] I included reproducible validation steps

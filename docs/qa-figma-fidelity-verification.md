# Figma fidelity correction verification

## Scope and result

This was an independent, source-backed check of the component-template fidelity correction in `src/adapters/export/figma.ts`. I retrieved the Figma exporter and responsive-template symbols through the configured Codebase MCP and found the normative per-feature rule in the indexed OpenSpec export section, then inspected both directly in the current checkout. The semantic query also returned unrelated symbols, so source inspection is the evidence for conclusions below. Production files were not changed by this audit.

The audit caught several overclaims in the first correction: unused component definitions were marked as though their layers were imported; instance-projected template roots retained unconditional `preserved` claims; text `style.fill` collided with Figma's single text `fills` property and was replaced by `textColor`; and vector/free-layout alignment and spacing were marked preserved although the importer does not set auto-layout on those target layers. The execution audit also found two type-specific cases: component `textColor` on a frame-root instance is not applied, while vector radius is applied to its SVG wrapper. The exporter now marks unused template features omitted, degrades mapped definition features with an explicit flattening fallback, omits unmapped text fills and non-text instance text color, reports vector radius as degraded on the wrapper, and omits layout fields the target layer does not apply.

## Execution evidence

`tests/audit/figma-fidelity-claims.test.ts` executes `buildFigmaScript` against a local Figma API double. It verifies the actual target name, instance sizing and fill override, omitted frame-root instance text color, and text fill winner plus visibility and alignment; checks that uninstantiated definitions and missing icon templates have no target layers; and checks vector style values and free-layout wrapper properties against their reported statuses. In a free-layout template, the importer places a child at its specified coordinates, and the report's child-position fallback describes child placement rather than root projection.

Existing `tests/export/figma-template-fidelity.test.ts` and `tests/export/figma-export.test.ts` cover template sizing defaults, text alignment and typography fallbacks, vector wrapper geometry, constraints, responsive flattening, shadows, and generated script behavior.

Focused verification passed:

```text
npx vitest run tests/audit/figma-fidelity-claims.test.ts tests/export/figma-template-fidelity.test.ts tests/export/figma-export.test.ts
3 files, 11 tests passed
```

## Remaining limits

This verifies the generated script using a purpose-built API double and reads the fidelity artifact; it does not import the bundle in a connected Figma session or certify visual behavior against Figma's live API. Figma export remains an offline developer-plugin archive, and the report correctly states that no Figma file was written. A child template's explicit position is applied relative to a free-layout parent; component identity and reusable-definition relationships remain flattened in the target and are retained in native JSON.

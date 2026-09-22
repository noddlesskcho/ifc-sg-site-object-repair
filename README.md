# IFC Repair Utility

Local static web app for BIM professionals repairing IFC+SG site-related objects and missing native `IfcStairFlight` information.

## Purpose

The app reads an IFC STEP file in the browser, matches selected `IfcSpace.LongName` values, checks IFC+SG property information, converts selected spaces to the required occurrence entities, repairs relationships, validates the result, and lets the user download the repaired IFC plus a JSON report.

The separate stair-flight workflow follows `IfcRelAggregates`, identifies child flights and `IfcSlab[LANDING]` objects, reads `Pset_StairCommon`, analyses web-ifc geometry in transformed coordinates, and fills only missing `NumberOfRisers`, `NumberOfTreads`, `RiserHeight`, and `TreadLength` attributes when the evidence is sufficient.

## Supported IFC Scope

- IFC4 only.
- IFC STEP physical files.
- Source objects represented as `IfcSpace`.
- Browser-only processing with File API, WebAssembly, web-ifc validation, and Blob downloads.
- No backend, database, login, upload, or cloud storage.
- No geometry editing.

## IfcStairFlight Repair

- Existing native stair-flight values are preserved.
- Straight-flight geometry is analysed after placements and mapped transformations are resolved by web-ifc.
- Millimetre and metre project units are supported.
- Parent stair dimensions can confirm geometry or provide a medium-confidence fallback for `RiserHeight` and `TreadLength`.
- Whole-stair riser and tread counts are never copied directly to every child flight.
- Parent totals validate child risers and child treads plus separate landing stages.
- Conflicts, irregular geometry, missing geometry, and unassigned flights are reported for manual review.
- Repair output is re-parsed and reopened with web-ifc before download is enabled.

## Repair Mappings

| Category | Target IFC entity | PredefinedType | ObjectType / IFC SubType |
| --- | --- | --- | --- |
| Site Coverage | `IfcBuildingElementProxy` | `USERDEFINED` | `SITECOVERAGE` |
| Site Boundary | `IfcGeographicElement` | `USERDEFINED` | `SITEBOUNDARY` |
| Planting Areas | `IfcGeographicElement` | `USERDEFINED` | `PLANTINGAREAS` |

## IFC+SG Property Checks

Site Coverage checks only the entity, `PredefinedType`, and `ObjectType`.

Site Boundary checks:

- `SGPset_GeographicElement.BroadLandUse`: `IfcLabel` or compatible text value.
- `SGPset_GeographicElement.VacantLand`: `IfcBoolean`.

Planting Areas checks:

- `SGPset_GeographicElementDimension.Area`: `IfcAreaMeasure`.
- `SGPset_GeographicElement.ApprovedSoilMixture`: `IfcBoolean`.
- `SGPset_GeographicElement.Status`: `IfcLabel` or compatible text.
- `SGPset_GeographicElement.Turf`: `IfcBoolean`.
- `SGPset_GeographicElement.TurfSpecies`: `IfcLabel` or compatible text.
- `SGPset_GeographicElement.Compensated`: `IfcBoolean`.
- `SGPset_GeographicElement.Encroachment`: `IfcBoolean`.
- `SGPset_GeographicElement.CarparkProvision`: `IfcBoolean`.

Property warnings are informational. The app does not create missing property sets, populate values, or change property values.

## Privacy

Your IFC file is processed locally in your browser. It is not uploaded or stored online.

## Local Setup

```bash
pnpm install
pnpm run dev
```

Open the Vite local URL. Do not open `index.html` through `file://`, because WebAssembly may not load correctly.

## Commands

```bash
pnpm run dev
pnpm run test
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run preview
```

## Static Hosting Suitability

The build uses relative asset paths and produces static files in `dist/`, suitable for GitHub Pages or other static hosting later. Publishing is intentionally not configured in this local task.

## Known Limitations

- Site-object repair supports only the three fixed IFC+SG mappings.
- Automatic stair calculation focuses on conventional straight flights. Curved, spiral, winder, tapered, and non-uniform stairs require manual review.
- It does not edit geometry.
- It does not validate the permitted `BroadLandUse` vocabulary.
- It preserves property relationships but removes space-only quantity relationships such as `Qto_SpaceBaseQuantities`.
- The repair is a focused IFC4 STEP transaction and should be reviewed in downstream BIM/IFC validation tools before formal submission.

Users should validate repaired IFC files before formal submission.

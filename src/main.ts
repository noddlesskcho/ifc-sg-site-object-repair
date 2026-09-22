import { CATEGORY_ORDER, CONVERSION_MAPPINGS } from "./ifc-config";
import { checkRequiredProperties, inspectIfc, matchSpaces, repairIfc } from "./ifc-engine";
import { analyseStairFlights, repairStairFlights } from "./stair-engine";
import type { IfcInspection, MatchResult, PropertyCheckResult, RepairCategory, RepairResult, RepairSelection, StairAnalysisResult, StairFieldAnalysis, StairFieldName, StairRepairResult, StatusKind } from "./types";
import { IfcWorkerClient } from "./worker-client";
import "./styles.css";

const worker = typeof Worker !== "undefined" ? new IfcWorkerClient() : undefined;

interface AppState {
  mode: "site" | "stairs";
  stage: number;
  status: StatusKind;
  message: string;
  file?: File;
  loadingFileName: string;
  loadingProgress: number;
  sourceText: string;
  inspection?: IfcInspection;
  searches: Record<RepairCategory, string>;
  skipped: RepairCategory[];
  selected: Partial<Record<RepairCategory, number[]>>;
  matches: MatchResult[];
  propertyChecks: PropertyCheckResult[];
  warningsAccepted: boolean;
  openPropertyGroups: Record<string, boolean>;
  repair?: RepairResult;
  stairAnalysis?: StairAnalysisResult;
  stairRepair?: StairRepairResult;
}

let state: AppState = {
  mode: "site",
  stage: 0,
  status: "waiting",
  message: "Select an IFC4 STEP file to begin.",
  loadingFileName: "",
  loadingProgress: 0,
  sourceText: "",
  searches: { siteCoverage: "", siteBoundary: "", plantingAreas: "" },
  skipped: [],
  selected: {},
  matches: [],
  propertyChecks: [],
  warningsAccepted: false,
  openPropertyGroups: {}
};

const app = document.querySelector<HTMLDivElement>("#app")!;

function setState(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  render();
}

function render() {
  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="header-graphic">${headerGraphic()}</div>
        <div class="topbar-text">
          <p class="eyebrow">IFC+SG Utility</p>
          <h1>IFC Repair Utility</h1>
          <p class="subtitle">Repair missing IFC+SG site information and native stair-flight attributes from Archicad models.</p>
        </div>
        <div class="status ${state.status}">${iconForStatus(state.status)}<span>${statusLabel(state.status)}</span></div>
      </header>
      ${renderModeTabs()}
      ${state.mode === "site" ? renderStepper() : ""}
      ${state.mode === "site" && state.stage === 4 ? "" : renderNotice()}
      ${state.mode === "site" ? renderStage() : renderStairWorkflow()}
    </main>`;
  bindEvents();
}

function renderModeTabs() {
  return `<nav class="mode-tabs" aria-label="Repair function">
    <button class="mode-tab ${state.mode === "site" ? "active" : ""}" data-mode="site" aria-selected="${state.mode === "site"}">Fix Missing IFC Information</button>
    <button class="mode-tab ${state.mode === "stairs" ? "active" : ""}" data-mode="stairs" aria-selected="${state.mode === "stairs"}">Fix Missing IfcStairFlight</button>
  </nav>`;
}

function renderNotice() {
  const showProgress = state.status === "processing" && state.loadingProgress > 0 && (state.mode === "stairs" || state.stage !== 0);
  return `<section class="notice ${showProgress ? "with-progress" : ""} ${state.status === "error" || state.status === "validation-failed" ? "danger" : state.status === "warning" ? "warn" : ""}">
    ${iconForStatus(state.status)}
    <div class="notice-body">
      <span>${state.message}</span>
      ${showProgress ? progressBar(state.loadingProgress) : ""}
    </div>
  </section>`;
}

function renderStepper() {
  const labels = ["Upload", "Match", "IFC+SG Check", "Review", "Download"];
  const items = labels
    .map((label, index) => {
      const stepState = index < state.stage ? "completed" : index === state.stage ? "current" : "upcoming";
      const disabled = canVisit(index) ? "" : "disabled";
      return `<li class="stepper-item ${stepState}">
        <button class="stepper-control" data-stage="${index}" ${disabled} aria-current="${index === state.stage ? "step" : "false"}" aria-label="Step ${index + 1} of ${labels.length}: ${label}">
          <span class="stepper-dot">${stepState === "completed" ? CheckIcon() : index + 1}</span>
          <span class="stepper-label">${label}</span>
        </button>
      </li>`;
    })
    .join("");
  return `
    <nav class="stepper" aria-label="Workflow progress">
      <ol class="stepper-list">${items}</ol>
      <p class="stepper-compact">Step ${state.stage + 1} of ${labels.length} — ${labels[state.stage]}</p>
    </nav>`;
}

function headerGraphic() {
  return `<svg viewBox="0 0 460 200" preserveAspectRatio="xMaxYMid slice" focusable="false" aria-hidden="true">
    <path d="M50 168 L50 66 L128 26 L206 66 L206 168" />
    <path d="M50 66 L128 104 L206 66" />
    <path d="M128 26 L128 104 L128 168" />
    <path class="accent" d="M206 66 L284 26 L362 66 L362 168 L284 208 L206 168" />
    <path class="accent" d="M284 26 L284 104 L362 66" />
    <path d="M362 66 L410 90" />
    <circle cx="50" cy="66" r="3.5" />
    <circle cx="128" cy="26" r="3.5" />
    <circle cx="206" cy="66" r="3.5" />
    <circle cx="128" cy="104" r="3.5" />
    <circle cx="284" cy="26" r="3.5" />
    <circle cx="362" cy="66" r="3.5" />
    <circle cx="284" cy="104" r="3.5" />
    <circle cx="410" cy="90" r="3.5" />
  </svg>`;
}

function renderStage() {
  if (state.stage === 0) return renderSelect();
  if (state.stage === 1) return renderMatch();
  if (state.stage === 2) return renderProperties();
  if (state.stage === 3) return renderReview();
  return renderDownload();
}

function renderSelect() {
  const warning = state.file && state.file.size > 100 * 1024 * 1024 ? `<p class="warning">This file is larger than 100 MB. You can continue, but processing may take longer.</p>` : "";
  const loaded = Boolean(state.inspection);
  const loading = state.status === "reading" || (state.status === "processing" && state.loadingProgress > 0);
  return `
    <section class="panel">
      <div class="upload ${loaded ? "compact" : ""} ${loading ? "loading" : ""}">
        ${FileUpIcon()}
        <div>
          <strong>${loading ? "Loading IFC file" : loaded ? "IFC file loaded" : "Choose IFC file"}</strong>
          <p>${
            loading
              ? `${escapeHtml(state.loadingFileName)} is being read and inspected.`
              : loaded
                ? `${escapeHtml(state.inspection!.filename)} is ready for matching.`
                : "Your IFC file is processed locally in your browser. It is not uploaded or stored online."
          }</p>
          ${loading ? progressBar(state.loadingProgress) : ""}
        </div>
        <label class="file-button" for="file">${loaded ? "Change file" : "Choose IFC file"}</label>
        <input id="file" class="hidden-file" type="file" accept=".ifc" />
        ${warning}
      </div>
      ${state.inspection ? inspectionSummary(state.inspection) : ""}
    </section>`;
}

function renderStairWorkflow() {
  if (!state.inspection) return renderSelect();
  const analysis = state.stairAnalysis;
  const repaired = state.stairRepair;
  return `<section class="panel stair-workflow">
    <div class="section-head">
      <div><h2>IfcStairFlight Analysis</h2><p>Calculates only missing native attributes using straight-flight geometry and parent stair evidence.</p></div>
      <button class="ghost" data-action="change-file">${FileUpIcon()} Change file</button>
      <input id="file" class="hidden-file" type="file" accept=".ifc" />
    </div>
    <div class="stair-file-strip">
      <strong>${escapeHtml(state.inspection.filename)}</strong>
      <span>${formatBytes(state.inspection.fileSize)} | ${escapeHtml(state.inspection.schema)} | ${state.inspection.entityCount.toLocaleString()} entities</span>
    </div>
    ${!analysis ? renderStairEmpty() : renderStairAnalysis(analysis)}
    ${repaired ? renderStairRepairResult(repaired) : ""}
  </section>`;
}

function renderStairEmpty() {
  if (state.status === "processing") {
    return `<div class="stair-empty">
      <h3>Analysing stair flights...</h3>
      <p>Checking flight properties, parent stair relationships, units and straight-flight geometry.</p>
    </div>`;
  }
  return `<div class="stair-empty">
    <h3>Stair analysis is ready to retry</h3>
    <p>The analysis normally starts automatically when a file is opened. Retrying does not change any IFC values.</p>
    <button data-action="analyse-stairs">${SearchIcon()} Analyse Again</button>
  </div>`;
}

function renderStairAnalysis(analysis: StairAnalysisResult) {
  const repairable = analysis.flights.filter((flight) => flight.repairableFields.length > 0 && flight.status !== "Conflict");
  return `<div class="stair-results">
    <div class="stair-scope-note">
      ${ShieldIcon()}
      <p><strong>Only information missing from both the stair flight and Pset_StairFlightCommon will be repaired.</strong> Existing native and property-set values are never overwritten. Orange values are proposed repairs; blue values already exist in the model.</p>
    </div>
    <div class="summary-grid stair-summary">
      ${metric("Stair flights", String(analysis.flights.length))}
      ${metric("Ready or partial", String(repairable.length))}
      ${metric("Length unit", analysis.lengthUnit)}
      ${metric("Parent stairs", String(analysis.parents.length))}
    </div>
    ${analysis.flights.length === 0 ? `<p class="warning">No IfcStairFlight entities were found in this file.</p>` : `
      <div class="table-wrap stair-table-wrap"><table class="stair-table">
        <thead><tr><th>Stair</th><th>Stair flight</th><th>Risers</th><th>Riser height</th><th>Treads</th><th>Tread length</th><th>Source</th><th>Status</th></tr></thead>
        <tbody>${analysis.flights.map((flight) => `<tr>
          <td>${escapeHtml(flight.parentStairName)}</td>
          <td><details class="flight-details"><summary><strong>${escapeHtml(flight.name)}</strong><small>#${flight.expressId}</small></summary>${renderFlightDetails(flight, analysis.lengthUnit)}</details></td>
          <td>${renderStairValue(flight.fields.numberOfRisers, "")}</td>
          <td>${renderStairValue(flight.fields.riserHeight, analysis.lengthUnit)}</td>
          <td>${renderStairValue(flight.fields.numberOfTreads, "")}</td>
          <td>${renderStairValue(flight.fields.treadLength, analysis.lengthUnit)}</td>
          <td>${escapeHtml([...new Set(Object.values(flight.fields).map((field) => sourceLabel(field.source)))].join(" + "))}</td>
          <td><span class="badge ${stairStatusClass(flight.status)}">${stairStatusLabel(flight.status)}</span></td>
        </tr>`).join("")}</tbody>
      </table></div>`}
    ${analysis.parents.length ? `<div class="parent-validations"><h3>Parent stair validation</h3>${analysis.parents.map((parent) => `<div class="parent-check ${parent.status.toLowerCase().replace(/\s+/g, "-")}"><strong>#${parent.expressId} ${escapeHtml(parent.name)}</strong><span class="badge ${parent.status === "Pass" ? "badge-success" : parent.status === "Conflict" ? "badge-danger" : "badge-neutral"}">${parent.status}</span><p>${escapeHtml(parent.message)} ${parent.landingIds.length} landing${parent.landingIds.length === 1 ? "" : "s"} found.</p></div>`).join("")}</div>` : ""}
    <div class="actions">
      <button class="ghost" data-action="analyse-stairs">${SearchIcon()} Analyse Again</button>
      <button data-action="repair-stairs" ${repairable.length === 0 ? "disabled" : ""}>${WrenchIcon()} ${repairable.length === 0 ? "Nothing to Repair" : "Repair Missing IfcStairFlight Information"}</button>
    </div>
  </div>`;
}

function renderFlightDetails(flight: StairAnalysisResult["flights"][number], unit: string) {
  const fields = Object.entries(flight.fields) as Array<[StairFieldName, StairFieldAnalysis]>;
  return `<div class="flight-detail-body">
    <dl>${fields.map(([name, field]) => `<div><dt>${stairFieldLabel(name)}</dt><dd>Existing: ${field.existing ?? "Missing"} | Result: ${field.value === undefined ? "Unresolved" : `${formatStairNumber(field.value)}${name === "riserHeight" || name === "treadLength" ? ` ${unit}` : ""}`} | ${sourceLabel(field.source)} | ${field.confidence}</dd></div>`).join("")}</dl>
    ${flight.evidence.length ? `<strong>Evidence</strong><ul>${flight.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
  </div>`;
}

function renderStairValue(field: StairFieldAnalysis, unit: string) {
  if (field.value === undefined) return `<span class="value-missing">Unresolved</span>`;
  const changed = field.existing === undefined;
  return `<span class="${changed ? "value-calculated" : "value-existing"}">${formatStairNumber(field.value)}${unit ? ` ${unit}` : ""}</span><small class="cell-source">${changed ? "Proposed from " : ""}${sourceLabel(field.source)}</small>`;
}

function renderStairRepairResult(result: StairRepairResult) {
  const passed = result.report.validation.passed;
  return `<div class="stair-download ${passed ? "passed" : "failed"}">
    <strong>${passed ? "Repair completed and validated" : "Post-repair validation failed"}</strong>
    <p>${result.report.fieldsWritten} resolved field${result.report.fieldsWritten === 1 ? "" : "s"} written to native attributes and ${result.report.propertyValuesWritten} missing Pset value${result.report.propertyValuesWritten === 1 ? "" : "s"} across ${result.report.flightsRepaired} flight${result.report.flightsRepaired === 1 ? "" : "s"}.</p>
    ${passed ? "" : errorList(result.report.validation.blockingErrors)}
    <div class="actions"><button class="secondary" data-action="download-stair-json">${FileJsonIcon()} Download JSON report</button><button data-action="download-stair-ifc" ${passed ? "" : "disabled"}>${DownloadIcon()} Download repaired IFC</button></div>
  </div>`;
}

function sourceLabel(source: StairFieldAnalysis["source"]) {
  return ({
    EXISTING: "Existing",
    FLIGHT_PSET: "Flight property",
    GEOMETRY: "Geometry",
    TESSELLATED_GEOMETRY: "Tessellated stair faces",
    PARENT_CONFIRMED: "Geometry + Parent",
    PARENT_FALLBACK: "Parent fallback",
    DERIVED: "Geometry derived",
    UNRESOLVED: "Unresolved"
  })[source];
}

function stairStatusClass(status: StairAnalysisResult["flights"][number]["status"]) {
  if (status === "Already Complete") return "badge-success";
  if (status === "Ready to Repair" || status === "Partial") return "badge-repair";
  return "badge-danger";
}

function stairStatusLabel(status: StairAnalysisResult["flights"][number]["status"]) {
  if (status === "Ready to Repair") return "Native Fields Missing";
  if (status === "Partial") return "Some Native Fields Missing";
  return status;
}

function stairFieldLabel(field: StairFieldName) {
  return ({ numberOfRisers: "NumberOfRisers", numberOfTreads: "NumberOfTreads", riserHeight: "RiserHeight", treadLength: "TreadLength" })[field];
}

function formatStairNumber(value: number) {
  return String(Math.round(value * 1000) / 1000);
}

function renderMatch() {
  return `
    <section class="panel">
      <div class="section-head">
        <h2>Match Source IfcSpace Objects</h2>
        <p>Enter the Archicad Zone Name used for each area. The app will match this against the IFC LongName.</p>
      </div>
      <div class="match-grid">
        ${CATEGORY_ORDER.map((category) => renderMatchCard(category)).join("")}
      </div>
      <div class="actions">
        <button class="ghost" data-action="back">${BackIcon()} Back to review</button>
        <button data-action="to-properties" ${selectedRepairs().length === 0 || hasUnresolvedDuplicateAssignment() ? "disabled" : ""}>Check IFC+SG Information</button>
      </div>
    </section>`;
}

function renderMatchCard(category: RepairCategory) {
  const mapping = CONVERSION_MAPPINGS[category];
  const match = state.matches.find((item) => item.category === category);
  const skipped = state.skipped.includes(category);
  const spaces = match?.matches ?? [];
  const selectedIds = state.selected[category] ?? [];
  const selectedSpaces = selectedIds
    .map((id) => state.inspection?.spaces.find((space) => space.expressId === id))
    .filter((space): space is NonNullable<typeof space> => Boolean(space));
  const badge = matchBadge(match, skipped, selectedSpaces.length, state.searches[category]);
  return `
    <article class="match-card">
      <div class="match-title">
        <h3>${mapping.label}</h3>
        <span class="badge ${badge.cls}">${badge.label}</span>
      </div>
      <input data-search="${category}" value="${escapeHtml(state.searches[category])}" placeholder="Archicad Zone Name" ${skipped ? "disabled" : ""} />
      <div class="mini-actions">
        <button class="icon-text ghost" data-action="search" data-category="${category}">${SearchIcon()} Search Again</button>
        <button class="ghost" data-action="${skipped ? "unskip" : "skip"}" data-category="${category}">${skipped ? "Restore" : "Skip"}</button>
      </div>
      <p class="muted">Match count: <strong>${spaces.length}</strong>. Selected: <strong class="${selectedSpaces.length > 0 ? "count-active" : ""}">${selectedSpaces.length}</strong>. Same IfcSpace cannot be assigned twice.</p>
      ${renderSelectedSpaces(category, selectedSpaces)}
      ${renderMatchSelection(category, spaces, match, selectedIds)}
      ${availableLongNames(category)}
    </article>`;
}

function matchBadge(match: MatchResult | undefined, skipped: boolean, selectedCount: number, searchValue: string) {
  if (skipped) return { label: "Skipped", cls: "badge-neutral" };
  if (!searchValue.trim() && selectedCount > 0) {
    return { label: `${selectedCount} Selected`, cls: "badge-success" };
  }
  const status = match?.status ?? "Waiting";
  return { label: status, cls: matchBadgeClass(match?.status) };
}

function matchBadgeClass(status?: MatchResult["status"]) {
  if (status === "Found") return "badge-success";
  if (status === "Multiple matches") return "badge-warning";
  if (status === "Not found" || status === "Duplicate assignment") return "badge-danger";
  if (status === "Skipped") return "badge-neutral";
  return "";
}

function renderSelectedSpaces(category: RepairCategory, spaces: IfcInspection["spaces"]) {
  if (spaces.length === 0) return "";
  return `<div class="selected-list">
    <strong class="subsection-label">Selected objects</strong>
    ${spaces.map((space) => renderSelectedPill(category, space)).join("")}
  </div>`;
}

function renderSelectedPill(category: RepairCategory, space: IfcInspection["spaces"][number]) {
  return `<div class="selected-pill">
    <span><span class="pill-check" aria-hidden="true">${CheckIcon()}</span><strong>#${space.expressId}</strong> ${escapeHtml(space.longName || "No LongName")}</span>
    <small>GlobalId ${escapeHtml(space.globalId)} | Storey ${escapeHtml(space.storeyName || "Unknown")} | Area ${escapeHtml(space.area || "Not found")}</small>
    <button class="ghost small-button" data-remove-selected="${category}" data-id="${space.expressId}" aria-label="Remove #${space.expressId}">Remove</button>
  </div>`;
}

function renderMatchSelection(category: RepairCategory, spaces: MatchResult["matches"], match: MatchResult | undefined, selectedIds: number[]) {
  if (!match || match.status === "Not found" || match.status === "Skipped" || match.status === "Found") return "";
  const remaining = spaces.filter((space) => !selectedIds.includes(space.expressId));
  if (remaining.length === 0) {
    return `<p class="muted">All objects matching this LongName are already selected above.</p>`;
  }
  return `<p class="warning">Multiple objects use this LongName. Select any additional objects to include.</p>${remaining
    .map((space) => renderSpaceChoice(category, space))
    .join("")}`;
}

function renderSpaceChoice(category: RepairCategory, space: { expressId: number; globalId: string; name: string; longName: string; storeyName?: string; area?: string }) {
  return `
    <label class="space-row">
      <input type="checkbox" name="${category}" data-select="${category}" value="${space.expressId}" />
      <span><strong>#${space.expressId}</strong> ${escapeHtml(space.longName || "No LongName")}</span>
      <small>GlobalId ${escapeHtml(space.globalId)} | Name ${escapeHtml(space.name || "Empty")} | Storey ${escapeHtml(space.storeyName || "Unknown")} | Area ${escapeHtml(space.area || "Not found")}</small>
    </label>`;
}

function renderProperties() {
  const warnings = state.propertyChecks.filter((check) => check.status !== "Passed" && check.status !== "Advisory");
  return `
    <section class="panel">
      <div class="section-head">
        <h2>IFC+SG Property Required Information</h2>
        <p>This check warns only. It does not create, populate, or change property values.</p>
      </div>
      <div class="property-columns">${CATEGORY_ORDER.map((category) => propertyCategoryCard(category)).join("")}</div>
      ${
        warnings.length
          ? `<div class="confirm">
              <p>Some IFC+SG required property information is missing, empty or incorrectly typed. This repair tool will not create or populate these values. Confirm that you want to continue.</p>
              <label><input type="checkbox" id="acceptWarnings" ${state.warningsAccepted ? "checked" : ""} /> I confirm that the missing, empty or incorrectly typed information is intended.</label>
            </div>`
          : `<p class="success">All applicable IFC+SG property checks passed.</p>`
      }
      <div class="actions">
        <button class="ghost" data-action="back">${BackIcon()} Back to review</button>
        <button data-action="to-review" ${warnings.length && !state.warningsAccepted ? "disabled" : ""}>Continue Repair</button>
      </div>
    </section>`;
}

function renderReview() {
  return `
    <section class="panel">
      <div class="section-head">
        <h2>Review Repair</h2>
        <p>No IFC changes are made until you click Repair IFC.</p>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Category</th><th>Matched LongName</th><th>GlobalId</th><th>Current entity</th><th>Repaired entity</th><th>PredefinedType</th><th>ObjectType / IFC SubType</th><th>Warnings</th></tr></thead>
          <tbody>${selectedRepairs()
            .map((selection) => {
              const space = state.inspection!.spaces.find((item) => item.expressId === selection.expressId)!;
              const mapping = CONVERSION_MAPPINGS[selection.category];
              const warningCount = state.propertyChecks.filter(
                (check) => check.category === selection.category && check.expressId === selection.expressId && check.status !== "Passed" && check.status !== "Advisory"
              ).length;
              return `<tr><td>${mapping.label}</td><td>${escapeHtml(space.longName)}</td><td class="mono">${escapeHtml(space.globalId)}</td><td>IfcSpace</td><td>${mapping.entityLabel}</td><td>${changeArrow(space.predefinedType || "Empty", mapping.predefinedType)}</td><td>${changeArrow(space.objectType || "Empty", mapping.objectType)}</td><td>${warningCount}</td></tr>`;
            })
            .join("")}</tbody>
        </table>
      </div>
      <div class="actions">
        <button class="ghost" data-action="back">${BackIcon()} Back to review</button>
        <button data-action="repair">${WrenchIcon()} Repair IFC</button>
      </div>
    </section>`;
}

function renderDownload() {
  const report = state.repair?.report;
  const passed = Boolean(report?.validation.passed);
  return `
    <section class="panel">
      <h2 class="visually-hidden">Download</h2>
      ${report ? completionPanel(report, passed) : ""}
      ${report && !passed ? errorList(report.validation.blockingErrors) : ""}
      ${report ? summaryBar(report) : ""}
      ${report ? reportSummary(report) : ""}
      <div class="actions actions-download">
        <button class="ghost" data-action="back">${BackIcon()} Back to review</button>
        <div class="actions-download-right">
          <button class="secondary" data-action="download-json">${FileJsonIcon()} Download JSON report</button>
          <button data-action="download-ifc" ${passed ? "" : "disabled"}>${DownloadIcon()} Download repaired IFC</button>
        </div>
      </div>
    </section>`;
}

function completionPanel(report: RepairResult["report"], passed: boolean) {
  return `<div class="completion-panel ${passed ? "success" : "failed"}">
    <span class="completion-icon">${passed ? CheckIcon() : AlertIcon()}</span>
    <div>
      <strong>${passed ? "Repair completed" : "Validation failed"}</strong>
      <p>${passed ? `${report.objectsRepaired} objects repaired and validation passed.` : "Review the blocking errors below before downloading."}</p>
    </div>
  </div>`;
}

function errorList(errors: string[]) {
  if (errors.length === 0) return "";
  return `<div class="error-list">${errors.map((error) => `<p>${escapeHtml(error)}</p>`).join("")}</div>`;
}

function summaryBar(report: RepairResult["report"]) {
  return `<div class="summary-bar">
    <div class="summary-bar-item">
      <span>Original file</span>
      <strong title="${escapeHtml(report.originalFilename)}">${escapeHtml(report.originalFilename)}</strong>
    </div>
    <div class="summary-bar-item">
      <span>Objects repaired</span>
      <strong>${report.objectsRepaired}</strong>
    </div>
    <div class="summary-bar-item">
      <span>Validation</span>
      <strong class="${report.validation.passed ? "value-positive" : "value-negative"}">${report.validation.passed ? CheckIcon() : AlertIcon()}${report.validation.passed ? "Passed" : "Failed"}</strong>
    </div>
  </div>
  <p class="muted output-filename">File will download as <span>${escapeHtml(report.outputFilename)}</span></p>`;
}

function changeArrow(oldValue: string, newValue: string) {
  return `<span class="change"><span class="change-from">${escapeHtml(oldValue)}</span><span class="change-sep" aria-hidden="true">&#8594;</span><span class="change-to">${escapeHtml(newValue)}</span></span>`;
}

function bindEvents() {
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) =>
    button.addEventListener("click", async () => {
      const mode = button.dataset.mode as AppState["mode"];
      setState({ mode, status: "waiting", message: mode === "site" ? "IFC+SG site-object repair is ready." : state.inspection ? "Analyse the loaded file for missing stair-flight information." : "Select an IFC4 STEP file to begin." });
      if (mode === "stairs" && state.inspection?.schema.toUpperCase() === "IFC4" && state.sourceText && !state.stairAnalysis) {
        await runStairAnalysis();
      }
    })
  );
  document.querySelector<HTMLInputElement>("#file")?.addEventListener("change", async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    setState({
      file,
      status: "reading",
      message: `Reading ${file.name}...`,
      loadingFileName: file.name,
      loadingProgress: 5,
      sourceText: "",
      inspection: undefined,
      stage: 0,
      searches: emptySearches(),
      skipped: [],
      selected: {},
      matches: [],
      propertyChecks: [],
      warningsAccepted: false,
      openPropertyGroups: {},
      repair: undefined,
      stairAnalysis: undefined,
      stairRepair: undefined
    });
    try {
      const bytes = await readFileWithProgress(file);
      setState({ status: "processing", loadingProgress: 75, message: `Opening ${file.name} with web-ifc...` });
      const value = await (async () => {
        if (worker) return worker.inspectBuffer(bytes, file.name, file.size);
        // Decode once and reuse it -- decoding the same (potentially 100MB+) buffer twice
        // was pure wasted work in the no-Worker fallback path.
        const decoded = new TextDecoder().decode(bytes);
        return { inspection: inspectIfc(decoded, file.name, file.size), text: decoded };
      })();
      setState({
        sourceText: value.text,
        inspection: value.inspection,
        stage: 0,
        loadingFileName: "",
        loadingProgress: 100,
        status: value.inspection.schema.toUpperCase() === "IFC4" ? "waiting" : "error",
        message: value.inspection.message ?? `Loaded ${value.inspection.spaces.length} IfcSpace objects from ${file.name}.`
      });
      if (state.mode === "stairs" && value.inspection.schema.toUpperCase() === "IFC4") await runStairAnalysis();
    } catch (error) {
      setState({ loadingProgress: 0, loadingFileName: "", inspection: undefined, sourceText: "", status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-stage]").forEach((button) =>
    button.addEventListener("click", async () => {
      const stage = Number(button.dataset.stage);
      if (stage === 2) {
        await goToProperties();
        return;
      }
      setState({ stage });
    })
  );
  document.querySelectorAll<HTMLInputElement>("[data-search]").forEach((input) =>
    input.addEventListener("input", () => {
      const category = input.dataset.search as RepairCategory;
      state.searches[category] = input.value;
      // filteredLongNameSpaces scans every IfcSpace on each call; for a very large model,
      // debounce the (lightweight, non-full-page) LongName list patch so fast typing
      // doesn't re-filter the whole list on every keystroke.
      scheduleLongNameUpdate(category);
    })
  );
  document.querySelectorAll<HTMLInputElement>("[data-select]").forEach((input) =>
    input.addEventListener("change", async () => {
      const category = input.dataset.select as RepairCategory;
      if (input.checked) {
        const id = Number(input.value);
        state.selected[category] = uniqueIds([...(state.selected[category] ?? []), id]);
      }
      await runMatch();
    })
  );
  document.querySelector<HTMLInputElement>("#acceptWarnings")?.addEventListener("change", (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    setState({ warningsAccepted: checked });
  });
  document.querySelectorAll<HTMLDetailsElement>(".property-object[data-group-key]").forEach((details) => {
    const summary = details.querySelector("summary");
    summary?.addEventListener("click", () => {
      const key = details.dataset.groupKey!;
      // The native open/close toggle runs as part of this same click, but after
      // listeners fire, so defer the read until it has applied. We deliberately do
      // NOT call setState/render here -- the native DOM already reflects the correct
      // open/closed state, and forcing a synchronous re-render on toggle both jumps
      // the page and can retrigger the details' own toggle event on re-insertion.
      // We only record the value so a LATER, unrelated re-render (e.g. ticking the
      // confirm checkbox) can reproduce it instead of resetting every group.
      setTimeout(() => {
        state.openPropertyGroups[key] = details.open;
      }, 0);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => button.addEventListener("click", () => handleAction(button.dataset.action!, button.dataset.category as RepairCategory)));
  document.querySelectorAll<HTMLButtonElement>("[data-remove-selected]").forEach((button) =>
    button.addEventListener("click", async () => {
      const category = button.dataset.removeSelected as RepairCategory;
      const id = Number(button.dataset.id);
      state.selected[category] = (state.selected[category] ?? []).filter((selectedId) => selectedId !== id);
      await runMatch();
    })
  );
  document.querySelectorAll<HTMLButtonElement>("[data-pick-longname]").forEach((button) =>
    button.addEventListener("click", async () => {
      const category = button.dataset.pickLongname as RepairCategory;
      state.searches[category] = button.dataset.value ?? "";
      await runMatch();
    })
  );
}

async function handleAction(action: string, category?: RepairCategory) {
  if (action === "change-file") document.querySelector<HTMLInputElement>("#file")?.click();
  if (action === "back") setState({ stage: Math.max(0, state.stage - 1) });
  if (action === "start-match") {
    setState({ stage: 1 });
    await runMatch();
  }
  if (action === "search" && category) await runMatch();
  if (action === "skip" && category) {
    setState({ skipped: [...new Set([...state.skipped, category])] });
    await runMatch();
  }
  if (action === "unskip" && category) {
    setState({ skipped: state.skipped.filter((item) => item !== category) });
    await runMatch();
  }
  if (action === "to-properties") {
    await goToProperties();
  }
  if (action === "to-review") setState({ stage: 3, status: "waiting", message: "Review the entity and relationship changes before repair." });
  if (action === "repair") await runRepair();
  if (action === "download-ifc" && state.repair) downloadText(state.repair.ifcText, state.repair.outputFilename, "application/x-step");
  if (action === "download-json" && state.repair) downloadText(JSON.stringify(state.repair.report, null, 2), state.repair.outputFilename.replace(/\.ifc$/i, ".json"), "application/json");
  if (action === "analyse-stairs") await runStairAnalysis();
  if (action === "repair-stairs") await runStairRepair();
  if (action === "download-stair-ifc" && state.stairRepair) downloadText(state.stairRepair.ifcText, state.stairRepair.outputFilename, "application/x-step");
  if (action === "download-stair-json" && state.stairRepair) downloadText(JSON.stringify(state.stairRepair.report, null, 2), state.stairRepair.outputFilename.replace(/\.ifc$/i, ".json"), "application/json");
}

async function runStairAnalysis() {
  if (!state.inspection || !state.sourceText) return;
  setState({ status: "processing", message: "Analysing stair relationships, properties, units and geometry...", loadingProgress: 18, stairRepair: undefined });
  try {
    const analysis = worker
      ? await worker.analyseStairs(state.sourceText, state.inspection.filename)
      : analyseStairFlights(state.sourceText, state.inspection.filename);
    const repairable = analysis.flights.filter((flight) => flight.repairableFields.length > 0 && flight.status !== "Conflict").length;
    setState({ stairAnalysis: analysis, status: analysis.flights.length ? "waiting" : "warning", loadingProgress: 100, message: analysis.flights.length ? `Analysed ${analysis.flights.length} stair flights; ${repairable} can be repaired automatically.` : "No IfcStairFlight entities were found." });
  } catch (error) {
    setState({ status: "error", loadingProgress: 0, message: error instanceof Error ? error.message : String(error) });
  }
}

async function runStairRepair() {
  if (!state.inspection || !state.stairAnalysis) return;
  setState({ status: "processing", loadingProgress: 25, message: "Writing missing stair-flight attributes and validating the repaired IFC..." });
  try {
    const repaired = worker
      ? await worker.repairStairs(state.sourceText, state.inspection.filename, state.stairAnalysis)
      : repairStairFlights(state.sourceText, state.inspection.filename, state.stairAnalysis);
    setState({ stairRepair: repaired, loadingProgress: 100, status: repaired.report.validation.passed ? "validation-passed" : "validation-failed", message: repaired.report.validation.passed ? `Repair complete. ${repaired.report.fieldsWritten} values were written to native attributes and Pset_StairFlightCommon, then re-validated.` : "Repair finished, but post-repair validation found blocking errors." });
  } catch (error) {
    setState({ status: "error", loadingProgress: 0, message: error instanceof Error ? error.message : String(error) });
  }
}

async function runMatch() {
  if (!state.inspection) return;
  const matches = worker ? await worker.match(state.inspection.spaces, state.searches, state.skipped, state.selected) : matchSpaces(state.inspection.spaces, state.searches, new Set(state.skipped), state.selected);
  const selected = { ...state.selected };
  const searches = { ...state.searches };
  for (const match of matches) {
    selected[match.category] = uniqueIds(match.selectedIds).filter((id) => state.inspection!.spaces.some((space) => space.expressId === id));
    if (match.status === "Found") {
      // A single unambiguous match just locked in above as a selected pill — clear the box
      // so the user can immediately search for another object under the same category.
      searches[match.category] = "";
    }
  }
  const unresolved = matches.some((match) => {
    if (state.skipped.includes(match.category)) return false;
    if (match.status === "Duplicate assignment") return true;
    return (selected[match.category] ?? []).length === 0;
  });
  setState({
    selected,
    searches,
    matches,
    status: unresolved ? "warning" : "waiting",
    message: "Matching complete. Resolve any missing, multiple, or duplicate assignments."
  });
}

let repairProgressTimer: ReturnType<typeof setInterval> | undefined;

function startRepairProgress() {
  stopRepairProgress();
  repairProgressTimer = setInterval(() => {
    const next = Math.min(92, state.loadingProgress + Math.random() * 7 + 3);
    setState({ loadingProgress: next });
  }, 220);
}

function stopRepairProgress() {
  if (repairProgressTimer !== undefined) {
    clearInterval(repairProgressTimer);
    repairProgressTimer = undefined;
  }
}

async function runRepair() {
  setState({ status: "processing", message: "Repairing relationships and validating the output in memory...", loadingProgress: 8 });
  startRepairProgress();
  try {
    const repair = worker
      ? await worker.repair(state.sourceText, state.inspection!.filename, selectedRepairs(), state.warningsAccepted)
      : repairIfc(state.sourceText, state.inspection!.filename, selectedRepairs(), state.warningsAccepted);
    stopRepairProgress();
    setState({
      repair,
      stage: 4,
      loadingProgress: 0,
      status: repair.report.validation.passed ? "validation-passed" : "validation-failed",
      message: repair.report.validation.passed ? "Repair completed and structural validation passed." : "Repair completed but structural validation found blocking errors."
    });
  } catch (error) {
    stopRepairProgress();
    setState({ status: "error", loadingProgress: 0, message: error instanceof Error ? error.message : String(error) });
  }
}

function selectedRepairs(): RepairSelection[] {
  return CATEGORY_ORDER.flatMap((category) => {
    if (state.skipped.includes(category)) return [];
    const stored = state.selected[category] ?? [];
    if (stored.length > 0) return stored.map((expressId) => ({ category, expressId }));
    const foundMatch = state.matches.find((match) => match.category === category && match.status === "Found");
    return foundMatch?.matches[0] ? [{ category, expressId: foundMatch.matches[0].expressId }] : [];
  });
}

function uniqueIds(ids: number[]) {
  return [...new Set(ids)];
}

// A "Duplicate assignment" match means the same IfcSpace is still selected under two
// categories at once. matchSpaces() flags this but deliberately leaves the id assigned to
// both categories so the user can see and resolve it -- it must not be allowed to reach
// repairIfc that way, since repairIfc converts each selection's record in place, and the
// second category to run would silently overwrite the first category's conversion.
function hasUnresolvedDuplicateAssignment(): boolean {
  return state.matches.some((match) => !state.skipped.includes(match.category) && match.status === "Duplicate assignment");
}

async function goToProperties() {
  if (hasUnresolvedDuplicateAssignment()) {
    setState({ stage: 1, status: "warning", message: "Resolve the duplicate object assignment before checking IFC+SG information -- the same object cannot be selected under two categories." });
    return;
  }
  const selections = selectedRepairs();
  if (selections.length === 0) {
    setState({ stage: 1, status: "warning", message: "Select or match at least one IFC space before checking IFC+SG information." });
    return;
  }
  setState({ status: "processing", message: "Checking IFC+SG property relationships..." });
  try {
    // Route through the worker when available, same as match() and repair() -- this
    // re-parses state.sourceText, which can be 100MB+, and doing that synchronously on
    // the main thread would freeze the UI for the duration of the parse.
    const checks = worker ? await worker.properties(state.sourceText, selections) : checkRequiredProperties(state.sourceText, selections);
    setState({
      propertyChecks: checks,
      openPropertyGroups: {},
      stage: 2,
      status: checks.some((check) => check.status !== "Passed" && check.status !== "Advisory") ? "warning" : "waiting",
      message: "Property review is ready."
    });
  } catch (error) {
    setState({ stage: 1, status: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

function inspectionSummary(inspection: IfcInspection) {
  return `<div class="summary-grid">
    ${metric("Filename", inspection.filename)}
    ${metric("File size", formatBytes(inspection.fileSize))}
    ${metric("Detected schema", inspection.schema)}
    ${metric("IFC exporter", inspection.exporter)}
    ${metric("Total entities", String(inspection.entityCount))}
    ${metric("IfcSpace objects", String(inspection.spaces.length))}
  </div>
  <div class="actions"><button data-action="${state.mode === "site" ? "start-match" : "analyse-stairs"}" ${inspection.schema.toUpperCase() !== "IFC4" ? "disabled" : ""}>${state.mode === "site" ? "Start Matching" : "Analyse Stair Flights"}</button></div>`;
}

function propertyCategoryCard(category: RepairCategory) {
  const mapping = CONVERSION_MAPPINGS[category];
  const checks = state.propertyChecks.filter((check) => check.category === category);
  if (category === "siteCoverage") {
    return `<article class="property-card">
      <h3>${mapping.label}</h3>
      <div class="property-item passed">
        <strong>Entity mapping</strong>
        <span>IfcSpace -> ${mapping.entityLabel}</span>
        <small>PredefinedType: USERDEFINED | ObjectType: ${mapping.objectType}</small>
      </div>
      <p class="muted">No additional IFC+SG property values are checked for Site Coverage.</p>
    </article>`;
  }
  return `<article class="property-card">
    <h3>${mapping.label}</h3>
    ${groupChecksByObject(checks)
      .map((group) => {
        const issueCount = group.checks.filter((check) => check.status !== "Passed" && check.status !== "Advisory").length;
        const groupKey = `${category}-${group.expressId}`;
        return `<details class="property-object ${issueCount > 0 ? "has-issues" : ""}" data-group-key="${groupKey}" ${state.openPropertyGroups[groupKey] ? "open" : ""}>
          <summary class="object-label">
            <span class="object-label-text">
              <strong>#${group.expressId} ${escapeHtml(group.longName || "No LongName")}</strong>
              <small>GlobalId ${escapeHtml(group.globalId || "Unknown")}</small>
            </span>
            <span class="badge ${issueCount > 0 ? "badge-warning" : "badge-success"}">${issueCount > 0 ? `${issueCount} issue${issueCount === 1 ? "" : "s"}` : "All passed"}</span>
            <span class="chevron" aria-hidden="true">${ChevronIcon()}</span>
          </summary>
          <div class="property-object-body">
            ${group.checks
              .map((check) => {
                const missing = check.status !== "Passed" && check.status !== "Advisory";
                const valueText = missing ? missingValueText(check) : `Current value: ${escapeHtml(check.currentValue)}`;
                return `<div class="property-item ${missing ? "missing" : "passed"}">
                  <div class="property-line"><strong>${check.property}</strong><span class="badge ${propertyBadgeClass(check.status)}">${check.status}</span></div>
                  <span>${valueText}</span>
                  <small>${check.propertySet} | ${check.expectedType} | Current type: ${check.currentType}</small>
                </div>`;
              })
              .join("")}
          </div>
        </details>`;
      })
      .join("")}
  </article>`;
}

function propertyBadgeClass(status: PropertyCheckResult["status"]) {
  if (status === "Passed") return "badge-success";
  if (status === "Advisory") return "badge-neutral";
  return "badge-warning";
}

function groupChecksByObject(checks: PropertyCheckResult[]) {
  const groups = new Map<number, { expressId: number; globalId: string; longName: string; checks: PropertyCheckResult[] }>();
  for (const check of checks) {
    const group = groups.get(check.expressId) ?? {
      expressId: check.expressId,
      globalId: check.globalId,
      longName: check.longName,
      checks: []
    };
    group.checks.push(check);
    groups.set(check.expressId, group);
  }
  return [...groups.values()];
}

function missingValueText(check: PropertyCheckResult) {
  if (check.status === "Missing property set") return `Missing value: property set ${check.propertySet} not found`;
  if (check.status === "Missing property") return `Missing value: ${check.property} not found`;
  if (check.status === "No value") return "Missing value: empty or unknown";
  if (check.status === "Wrong data type") return `Value needs review: ${escapeHtml(check.currentValue)} has type ${check.currentType}`;
  return `Value needs review: ${escapeHtml(check.currentValue)}`;
}

function reportSummary(report: RepairResult["report"]) {
  return `<h2 class="section-title">Repair summary</h2>
  <div class="table-wrap"><table><thead><tr><th>Category</th><th>GlobalId</th><th>Entity</th><th>PredefinedType</th><th>ObjectType / IFC SubType</th></tr></thead><tbody>${report.entityChanges
    .map(
      (change) =>
        `<tr><td>${change.category}</td><td class="mono">${escapeHtml(change.globalId)}</td><td>${changeArrow(change.oldEntity, change.newEntity)}</td><td>${changeArrow(change.oldPredefinedType, change.newPredefinedType)}</td><td>${changeArrow(change.oldObjectType, change.newObjectType)}</td></tr>`
    )
    .join("")}</tbody></table></div>
  <details class="report-disclosure">
    <summary><span class="chevron">${ChevronIcon()}</span><span>Relationship and property report</span></summary>
    <div class="report-body"><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre></div>
  </details>`;
}

function availableLongNames(category: RepairCategory) {
  if (!state.inspection) return "";
  const spaces = filteredLongNameSpaces(category);
  return `<details class="available" open>
    <summary>Available IfcSpace.LongName values <span data-longname-count="${category}">${longNameCountLabel(spaces.length)}</span></summary>
    <div class="longname-list" data-longname-list="${category}">${renderLongNameButtons(category, spaces)}</div>
  </details>`;
}

function emptySearches(): Record<RepairCategory, string> {
  return { siteCoverage: "", siteBoundary: "", plantingAreas: "" };
}

function filteredLongNameSpaces(category: RepairCategory) {
  if (!state.inspection) return [];
  const filter = state.searches[category].trim();
  if (!filter) return state.inspection.spaces;
  const normalFilter = normalizeForFilter(filter);
  return state.inspection.spaces.filter((space) => {
    const longName = space.longName || "";
    return longName.toLowerCase().includes(filter.toLowerCase()) || normalizeForFilter(longName).includes(normalFilter);
  });
}

// Large models can have thousands of IfcSpace objects; rendering every one as a DOM button
// (especially with an empty search, which matches everything) is needless work and a huge
// DOM for the browser to manage. Cap what's actually rendered and tell the user to narrow
// their search instead of silently truncating.
const LONGNAME_RENDER_LIMIT = 200;

function renderLongNameButtons(category: RepairCategory, spaces: IfcInspection["spaces"]) {
  if (spaces.length === 0) return `<p class="muted empty-list">No LongName values match this keyword.</p>`;
  const visible = spaces.slice(0, LONGNAME_RENDER_LIMIT);
  const buttons = visible
    .map((space) => `<button class="longname" data-pick-longname="${category}" data-value="${escapeHtml(space.longName)}">#${space.expressId} ${escapeHtml(space.longName || "Empty LongName")}</button>`)
    .join("");
  if (spaces.length <= LONGNAME_RENDER_LIMIT) return buttons;
  return `${buttons}<p class="muted empty-list">Showing the first ${LONGNAME_RENDER_LIMIT} of ${spaces.length} matches. Refine your search to narrow the list.</p>`;
}

function longNameCountLabel(total: number) {
  return total > LONGNAME_RENDER_LIMIT ? `${LONGNAME_RENDER_LIMIT} of ${total} shown` : `${total} shown`;
}

const longNameUpdateTimers: Partial<Record<RepairCategory, ReturnType<typeof setTimeout>>> = {};

function scheduleLongNameUpdate(category: RepairCategory) {
  const existing = longNameUpdateTimers[category];
  if (existing) clearTimeout(existing);
  longNameUpdateTimers[category] = setTimeout(() => {
    delete longNameUpdateTimers[category];
    updateLongNameList(category);
  }, 120);
}

function updateLongNameList(category: RepairCategory) {
  const list = document.querySelector<HTMLDivElement>(`[data-longname-list="${category}"]`);
  const count = document.querySelector<HTMLSpanElement>(`[data-longname-count="${category}"]`);
  if (!list) return;
  const spaces = filteredLongNameSpaces(category);
  list.innerHTML = renderLongNameButtons(category, spaces);
  if (count) count.textContent = longNameCountLabel(spaces.length);
  list.querySelectorAll<HTMLButtonElement>("[data-pick-longname]").forEach((button) =>
    button.addEventListener("click", async () => {
      const pickedCategory = button.dataset.pickLongname as RepairCategory;
      state.searches[pickedCategory] = button.dataset.value ?? "";
      await runMatch();
    })
  );
}

function normalizeForFilter(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function progressBar(value: number) {
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  return `<div class="progress" aria-label="IFC loading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${bounded}" role="progressbar">
    <span style="width: ${bounded}%"></span>
  </div>
  <small>${bounded}% complete</small>`;
}

function readFileWithProgress(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (!event.lengthComputable) {
        setState({ loadingProgress: 35 });
        return;
      }
      const readProgress = Math.round((event.loaded / event.total) * 65);
      setState({ loadingProgress: Math.max(5, readProgress), message: `Reading ${file.name}...` });
    };
    reader.onerror = () => reject(reader.error ?? new Error("The selected file could not be read."));
    reader.onload = () => {
      setState({ loadingProgress: 70, message: `Finished reading ${file.name}. Inspecting IFC records...` });
      resolve(reader.result as ArrayBuffer);
    };
    reader.readAsArrayBuffer(file);
  });
}

function canVisit(index: number) {
  if (index === 0) return true;
  if (!state.inspection || state.inspection.schema.toUpperCase() !== "IFC4") return false;
  if (index === 1) return true;
  if (index === 2) return selectedRepairs().length > 0 && !hasUnresolvedDuplicateAssignment();
  if (index === 3) return state.propertyChecks.length > 0;
  return Boolean(state.repair);
}

function downloadText(text: string, filename: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function metric(label: string, value: string) {
  return `<div class="metric"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function statusLabel(status: StatusKind) {
  return status.replace(/-/g, " ");
}

function iconForStatus(status: StatusKind) {
  if (status === "error" || status === "validation-failed") return AlertIcon();
  if (status === "warning") return AlertIcon();
  if (status === "validation-passed" || status === "repair-completed") return CheckIcon();
  return ShieldIcon();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]!);
}

const FileUpIcon = () => icon("icon-file-up");
const SearchIcon = () => icon("icon-search");
const WrenchIcon = () => icon("icon-wrench");
const DownloadIcon = () => icon("icon-download");
const FileJsonIcon = () => icon("icon-json");
const AlertIcon = () => icon("icon-alert");
const CheckIcon = () => icon("icon-check");
const ShieldIcon = () => icon("icon-shield");
const BackIcon = () => icon("icon-arrow-left");
const ChevronIcon = () => icon("icon-chevron");

function icon(id: string) {
  return `<svg aria-hidden="true"><use href="#${id}"></use></svg>`;
}

document.body.insertAdjacentHTML(
  "beforeend",
  `<svg class="icon-defs" xmlns="http://www.w3.org/2000/svg">
    <symbol id="icon-file-up" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 12v6"/><path d="m15 15-3-3-3 3"/></symbol>
    <symbol id="icon-search" viewBox="0 0 24 24"><path d="m21 21-4.3-4.3"/><circle cx="11" cy="11" r="8"/></symbol>
    <symbol id="icon-wrench" viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5 5L3 18l3 3 6.7-6.7a4 4 0 0 0 5-5l-2.4 2.4-2.8-2.8z"/></symbol>
    <symbol id="icon-download" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></symbol>
    <symbol id="icon-json" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12a2 2 0 0 0-2 2v1a2 2 0 0 1-2 2 2 2 0 0 1 2 2v1a2 2 0 0 0 2 2"/><path d="M14 12a2 2 0 0 1 2 2v1a2 2 0 0 0 2 2 2 2 0 0 0-2 2v1a2 2 0 0 1-2 2"/></symbol>
    <symbol id="icon-alert" viewBox="0 0 24 24"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></symbol>
    <symbol id="icon-check" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></symbol>
    <symbol id="icon-shield" viewBox="0 0 24 24"><path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></symbol>
    <symbol id="icon-arrow-left" viewBox="0 0 24 24"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></symbol>
    <symbol id="icon-chevron" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></symbol>
  </svg>`
);

render();

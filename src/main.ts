import { CATEGORY_ORDER, CONVERSION_MAPPINGS } from "./ifc-config";
import { checkRequiredProperties, inspectIfc, matchSpaces, repairIfc } from "./ifc-engine";
import type { IfcInspection, MatchResult, PropertyCheckResult, RepairCategory, RepairResult, RepairSelection, StatusKind } from "./types";
import { IfcWorkerClient } from "./worker-client";
import "./styles.css";

const worker = typeof Worker !== "undefined" ? new IfcWorkerClient() : undefined;

interface AppState {
  stage: number;
  status: StatusKind;
  message: string;
  file?: File;
  sourceText: string;
  inspection?: IfcInspection;
  searches: Record<RepairCategory, string>;
  skipped: RepairCategory[];
  selected: Partial<Record<RepairCategory, number[]>>;
  matches: MatchResult[];
  propertyChecks: PropertyCheckResult[];
  warningsAccepted: boolean;
  repair?: RepairResult;
}

let state: AppState = {
  stage: 0,
  status: "waiting",
  message: "Select an IFC4 STEP file to begin.",
  sourceText: "",
  searches: { siteCoverage: "", siteBoundary: "", plantingAreas: "" },
  skipped: [],
  selected: {},
  matches: [],
  propertyChecks: [],
  warningsAccepted: false
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
        <div>
          <p class="eyebrow">Local IFC+SG utility</p>
          <h1>Site Object Repair</h1>
        </div>
        <div class="status ${state.status}">${statusLabel(state.status)}</div>
      </header>
      <nav class="steps">${["Select IFC", "Match Objects", "Check IFC+SG Information", "Review Repair", "Repair and Download"]
        .map((label, index) => `<button class="${index === state.stage ? "active" : ""}" data-stage="${index}" ${canVisit(index) ? "" : "disabled"}>${index + 1}. ${label}</button>`)
        .join("")}</nav>
      <section class="notice ${state.status === "error" || state.status === "validation-failed" ? "danger" : state.status === "warning" ? "warn" : ""}">
        ${iconForStatus(state.status)}<span>${state.message}</span>
      </section>
      ${renderStage()}
    </main>`;
  bindEvents();
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
  return `
    <section class="panel">
      <div class="upload ${loaded ? "compact" : ""}">
        ${FileUpIcon()}
        <div>
          <strong>${loaded ? "IFC file loaded" : "Choose IFC file"}</strong>
          <p>${loaded ? `${escapeHtml(state.inspection!.filename)} is ready for matching.` : "Your IFC file is processed locally in your browser. It is not uploaded or stored online."}</p>
        </div>
        <label class="file-button" for="file">${loaded ? "Change file" : "Choose IFC file"}</label>
        <input id="file" class="hidden-file" type="file" accept=".ifc" />
        ${warning}
      </div>
      ${state.inspection ? inspectionSummary(state.inspection) : ""}
    </section>`;
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
        <button class="secondary" data-action="back">Back and Review</button>
        <button data-action="to-properties" ${selectedRepairs().length === 0 ? "disabled" : ""}>Check IFC+SG Information</button>
      </div>
    </section>`;
}

function renderMatchCard(category: RepairCategory) {
  const mapping = CONVERSION_MAPPINGS[category];
  const match = state.matches.find((item) => item.category === category);
  const skipped = state.skipped.includes(category);
  const spaces = match?.matches ?? [];
  const selectedIds = state.selected[category] ?? [];
  return `
    <article class="match-card">
      <div class="match-title">
        <h3>${mapping.label}</h3>
        <span class="badge">${match?.status ?? "Waiting"}</span>
      </div>
      <input data-search="${category}" value="${escapeHtml(state.searches[category])}" placeholder="Archicad Zone Name" ${skipped ? "disabled" : ""} />
      <div class="mini-actions">
        <button class="icon-text" data-action="search" data-category="${category}">${SearchIcon()} Search Again</button>
        <button class="ghost" data-action="${skipped ? "unskip" : "skip"}" data-category="${category}">${skipped ? "Restore" : "Skip"}</button>
      </div>
      <p class="muted">Match count: ${spaces.length}. Same IfcSpace cannot be assigned twice.</p>
      ${renderMatchSelection(category, spaces, match, selectedIds)}
      ${availableLongNames(category)}
    </article>`;
}

function renderMatchSelection(category: RepairCategory, spaces: MatchResult["matches"], match: MatchResult | undefined, selectedIds: number[]) {
  if (!match || match.status === "Not found" || match.status === "Skipped") return "";
  if (match.status === "Found") {
    const space = spaces[0];
    return `<div class="selected-space">
      <strong>Auto-selected #${space.expressId}</strong>
      <span>${escapeHtml(space.longName || "No LongName")}</span>
      <small>GlobalId ${escapeHtml(space.globalId)} | Storey ${escapeHtml(space.storeyName || "Unknown")} | Area ${escapeHtml(space.area || "Not found")}</small>
    </div>`;
  }
  return `<p class="warning">Multiple objects use this LongName. Select the intended object or objects.</p>${spaces
    .map((space) => renderSpaceChoice(category, space, selectedIds))
    .join("")}`;
}

function renderSpaceChoice(category: RepairCategory, space: { expressId: number; globalId: string; name: string; longName: string; storeyName?: string; area?: string }, selectedIds: number[]) {
  const checked = selectedIds.includes(space.expressId) ? "checked" : "";
  return `
    <label class="space-row">
      <input type="checkbox" name="${category}" data-select="${category}" value="${space.expressId}" ${checked} />
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
        <button class="secondary" data-action="back">Back and Review</button>
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
              const warningCount = state.propertyChecks.filter((check) => check.category === selection.category && check.status !== "Passed" && check.status !== "Advisory").length;
              return `<tr><td>${mapping.label}</td><td>${escapeHtml(space.longName)}</td><td>${escapeHtml(space.globalId)}</td><td>IfcSpace</td><td>${mapping.entityLabel}</td><td>${space.predefinedType || "Empty"} -> ${mapping.predefinedType}</td><td>${escapeHtml(space.objectType || "Empty")} -> ${mapping.objectType}</td><td>${warningCount}</td></tr>`;
            })
            .join("")}</tbody>
        </table>
      </div>
      <div class="actions">
        <button class="secondary" data-action="back">Back and Review</button>
        <button data-action="repair">${WrenchIcon()} Repair IFC</button>
      </div>
    </section>`;
}

function renderDownload() {
  const report = state.repair?.report;
  return `
    <section class="panel">
      <div class="section-head">
        <h2>Repair and Download</h2>
        <p>${report?.validation.passed ? "Validation passed. The repaired IFC is ready to download." : "Validation failed. Review the blocking errors before retrying."}</p>
      </div>
      ${report ? reportSummary(report) : ""}
      <div class="actions">
        <button class="secondary" data-action="back">Back and Review</button>
        <button data-action="download-ifc" ${report?.validation.passed ? "" : "disabled"}>${DownloadIcon()} Download Repaired IFC</button>
        <button class="secondary" data-action="download-json">${FileJsonIcon()} Download Report JSON</button>
      </div>
    </section>`;
}

function bindEvents() {
  document.querySelector<HTMLInputElement>("#file")?.addEventListener("change", async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    setState({
      file,
      status: "reading",
      message: "Reading IFC and opening it with web-ifc...",
      searches: emptySearches(),
      skipped: [],
      selected: {},
      matches: [],
      propertyChecks: [],
      warningsAccepted: false,
      repair: undefined
    });
    try {
      const value = worker ? await worker.inspect(file) : { inspection: inspectIfc(await file.text(), file.name, file.size), text: await file.text() };
      setState({
        sourceText: value.text,
        inspection: value.inspection,
        stage: 0,
        status: value.inspection.schema.toUpperCase() === "IFC4" ? "waiting" : "error",
        message: value.inspection.message ?? `Loaded ${value.inspection.spaces.length} IfcSpace objects from ${file.name}.`
      });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-stage]").forEach((button) => button.addEventListener("click", () => setState({ stage: Number(button.dataset.stage) })));
  document.querySelectorAll<HTMLInputElement>("[data-search]").forEach((input) =>
    input.addEventListener("input", () => {
      const category = input.dataset.search as RepairCategory;
      state.searches[category] = input.value;
      state.selected[category] = [];
    })
  );
  document.querySelectorAll<HTMLInputElement>("[data-select]").forEach((input) =>
    input.addEventListener("change", async () => {
      const category = input.dataset.select as RepairCategory;
      const checked = [...document.querySelectorAll<HTMLInputElement>(`[data-select="${category}"]:checked`)].map((item) => Number(item.value));
      state.selected[category] = checked;
      await runMatch();
    })
  );
  document.querySelector<HTMLInputElement>("#acceptWarnings")?.addEventListener("change", (event) => setState({ warningsAccepted: (event.target as HTMLInputElement).checked }));
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => button.addEventListener("click", () => handleAction(button.dataset.action!, button.dataset.category as RepairCategory)));
  document.querySelectorAll<HTMLButtonElement>("[data-pick-longname]").forEach((button) =>
    button.addEventListener("click", async () => {
      const category = button.dataset.pickLongname as RepairCategory;
      state.searches[category] = button.dataset.value ?? "";
      state.selected[category] = [];
      await runMatch();
    })
  );
}

async function handleAction(action: string, category?: RepairCategory) {
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
    setState({ status: "processing", message: "Checking IFC+SG property relationships..." });
    const selections = selectedRepairs();
    const checks = worker ? await worker.properties(state.sourceText, selections) : checkRequiredProperties(state.sourceText, selections);
    setState({ propertyChecks: checks, stage: 2, status: checks.some((check) => check.status !== "Passed" && check.status !== "Advisory") ? "warning" : "waiting", message: "Property review is ready." });
  }
  if (action === "to-review") setState({ stage: 3, status: "waiting", message: "Review the entity and relationship changes before repair." });
  if (action === "repair") await runRepair();
  if (action === "download-ifc" && state.repair) downloadText(state.repair.ifcText, state.repair.outputFilename, "application/x-step");
  if (action === "download-json" && state.repair) downloadText(JSON.stringify(state.repair.report, null, 2), state.repair.outputFilename.replace(/\.ifc$/i, ".json"), "application/json");
}

async function runMatch() {
  if (!state.inspection) return;
  const matches = worker ? await worker.match(state.inspection.spaces, state.searches, state.skipped, state.selected) : matchSpaces(state.inspection.spaces, state.searches, new Set(state.skipped), state.selected);
  const selected = { ...state.selected };
  for (const match of matches) {
    selected[match.category] = match.status === "Found" ? match.selectedIds : match.selectedIds.filter((id) => match.matches.some((space) => space.expressId === id));
  }
  setState({ selected, matches, status: matches.some((match) => match.status.includes("Multiple") || match.status.includes("Duplicate") || match.status === "Not found") ? "warning" : "waiting", message: "Matching complete. Resolve any missing, multiple, or duplicate assignments." });
}

async function runRepair() {
  setState({ status: "processing", message: "Repairing relationships and validating the output in memory..." });
  try {
    const repair = worker
      ? await worker.repair(state.sourceText, state.inspection!.filename, selectedRepairs(), state.warningsAccepted)
      : repairIfc(state.sourceText, state.inspection!.filename, selectedRepairs(), state.warningsAccepted);
    setState({
      repair,
      stage: 4,
      status: repair.report.validation.passed ? "validation-passed" : "validation-failed",
      message: repair.report.validation.passed ? "Repair completed and structural validation passed." : "Repair completed but structural validation found blocking errors."
    });
  } catch (error) {
    setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

function selectedRepairs(): RepairSelection[] {
  return CATEGORY_ORDER.flatMap((category) => (state.skipped.includes(category) ? [] : (state.selected[category] ?? []).map((expressId) => ({ category, expressId }))));
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
  <div class="actions"><button data-action="start-match" ${inspection.schema.toUpperCase() !== "IFC4" ? "disabled" : ""}>Start Matching</button></div>`;
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
    ${checks
      .map((check) => {
        const missing = check.status !== "Passed" && check.status !== "Advisory";
        const valueText = missing ? missingValueText(check) : `Current value: ${escapeHtml(check.currentValue)}`;
        return `<div class="property-item ${missing ? "missing" : "passed"}">
          <div class="property-line"><strong>${check.property}</strong><span class="badge">${check.status}</span></div>
          <span>${valueText}</span>
          <small>${check.propertySet} | ${check.expectedType} | Current type: ${check.currentType}</small>
        </div>`;
      })
      .join("")}
  </article>`;
}

function missingValueText(check: PropertyCheckResult) {
  if (check.status === "Missing property set") return `Missing value: property set ${check.propertySet} not found`;
  if (check.status === "Missing property") return `Missing value: ${check.property} not found`;
  if (check.status === "No value") return "Missing value: empty or unknown";
  if (check.status === "Wrong data type") return `Value needs review: ${escapeHtml(check.currentValue)} has type ${check.currentType}`;
  return `Value needs review: ${escapeHtml(check.currentValue)}`;
}

function reportSummary(report: RepairResult["report"]) {
  return `<div class="summary-grid">
    ${metric("Original filename", report.originalFilename)}
    ${metric("Output filename", report.outputFilename)}
    ${metric("Objects repaired", String(report.objectsRepaired))}
    ${metric("Validation", report.validation.passed ? "Passed" : "Failed")}
  </div>
  <div class="table-wrap"><table><thead><tr><th>Category</th><th>GlobalId</th><th>Entity</th><th>PredefinedType</th><th>ObjectType / IFC SubType</th></tr></thead><tbody>${report.entityChanges
    .map((change) => `<tr><td>${change.category}</td><td>${escapeHtml(change.globalId)}</td><td>${change.oldEntity} -> ${change.newEntity}</td><td>${change.oldPredefinedType} -> ${change.newPredefinedType}</td><td>${change.oldObjectType} -> ${change.newObjectType}</td></tr>`)
    .join("")}</tbody></table></div>
  ${report.validation.blockingErrors.length ? `<div class="error-list">${report.validation.blockingErrors.map((error) => `<p>${escapeHtml(error)}</p>`).join("")}</div>` : ""}
  <details><summary>Relationship and property report</summary><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre></details>`;
}

function availableLongNames(category: RepairCategory) {
  if (!state.inspection) return "";
  return `<details class="available" open><summary>Available IfcSpace.LongName values</summary>${state.inspection.spaces
    .map((space) => `<button class="longname" data-pick-longname="${category}" data-value="${escapeHtml(space.longName)}">#${space.expressId} ${escapeHtml(space.longName || "Empty LongName")}</button>`)
    .join("")}</details>`;
}

function emptySearches(): Record<RepairCategory, string> {
  return { siteCoverage: "", siteBoundary: "", plantingAreas: "" };
}

function canVisit(index: number) {
  if (index === 0) return true;
  if (!state.inspection || state.inspection.schema.toUpperCase() !== "IFC4") return false;
  if (index === 1) return true;
  if (index === 2) return selectedRepairs().length > 0;
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
  </svg>`
);

render();

import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { ErrorBanner, SuccessBanner } from "../components/feedback/Banner";
import { TextAreaField, TextField } from "../components/forms/FormFields";
import { requestJson } from "../lib/apiClient";

const emptyVehicleForm = {
  year: "",
  make: "",
  model: "",
  trim: "",
  engine: "",
};

const emptyDocumentDefaultsForm = {
  commonSystemsText: "",
  documentTypesText: "",
};

const emptyDocumentDefaults = {
  commonSystems: [],
  documentTypes: [],
};

const emptyBackupExport = {
  supported: false,
  path: "",
  message:
    "Backup export details are not available from the server yet. Restart the app and try again.",
};

function listToTextareaValue(items) {
  return Array.isArray(items) ? items.join("\n") : "";
}

function parseLineList(value) {
  const lines = typeof value === "string" ? value.split(/\r?\n/) : [];
  const nextItems = [];
  const seenItems = new Set();

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      continue;
    }

    const normalizedKey = trimmedLine.toLowerCase();

    if (seenItems.has(normalizedKey)) {
      continue;
    }

    seenItems.add(normalizedKey);
    nextItems.push(trimmedLine);
  }

  return nextItems;
}

function RuntimeRow({ label, value, helpText = "" }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 break-all font-mono text-sm text-slate-900">{value}</p>
      {helpText ? <p className="mt-2 text-xs text-slate-600">{helpText}</p> : null}
    </div>
  );
}

function SavedListPreview({ label, items, emptyMessage }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>

      {items.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {items.map((item) => (
            <span
              key={item}
              className="rounded-full bg-white px-3 py-1 text-sm text-slate-700 shadow-sm"
            >
              {item}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-600">{emptyMessage}</p>
      )}
    </div>
  );
}

export function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [vehicleForm, setVehicleForm] = useState(emptyVehicleForm);
  const [vehicleSaving, setVehicleSaving] = useState(false);
  const [vehicleSaveMessage, setVehicleSaveMessage] = useState("");
  const [vehicleSaveError, setVehicleSaveError] = useState("");

  const [documentDefaultsForm, setDocumentDefaultsForm] = useState(
    emptyDocumentDefaultsForm
  );
  const [savedDocumentDefaults, setSavedDocumentDefaults] = useState(
    emptyDocumentDefaults
  );
  const [defaultsSaving, setDefaultsSaving] = useState(false);
  const [defaultsSaveMessage, setDefaultsSaveMessage] = useState("");
  const [defaultsSaveError, setDefaultsSaveError] = useState("");

  const [runtime, setRuntime] = useState(null);
  const [backupExport, setBackupExport] = useState(emptyBackupExport);
  const [backupExportMessage, setBackupExportMessage] = useState("");
  const [backupExportError, setBackupExportError] = useState("");

  useEffect(() => {
    async function loadSettings() {
      try {
        setLoadError("");
        setLoading(true);

        const payload = await requestJson("/api/settings", {
          errorMessage: "Could not load settings.",
        });

        const nextDocumentDefaults = {
          commonSystems: payload.documentDefaults?.commonSystems || [],
          documentTypes: payload.documentDefaults?.documentTypes || [],
        };

        setVehicleForm({
          year: String(payload.vehicle?.year || ""),
          make: payload.vehicle?.make || "",
          model: payload.vehicle?.model || "",
          trim: payload.vehicle?.trim || "",
          engine: payload.vehicle?.engine || "",
        });
        setSavedDocumentDefaults(nextDocumentDefaults);
        setDocumentDefaultsForm({
          commonSystemsText: listToTextareaValue(nextDocumentDefaults.commonSystems),
          documentTypesText: listToTextareaValue(nextDocumentDefaults.documentTypes),
        });
        setRuntime(payload.runtime || null);
        setBackupExport(payload.backupExport || emptyBackupExport);
      } catch (error) {
        setLoadError(error.message || "Could not load settings.");
      } finally {
        setLoading(false);
      }
    }

    loadSettings();
  }, []);

  function handleVehicleChange(event) {
    const { name, value } = event.target;

    setVehicleForm((currentForm) => ({
      ...currentForm,
      [name]: value,
    }));
  }

  function handleDocumentDefaultsChange(event) {
    const { name, value } = event.target;

    setDocumentDefaultsForm((currentForm) => ({
      ...currentForm,
      [name]: value,
    }));
  }

  async function handleVehicleSave(event) {
    event.preventDefault();

    try {
      setVehicleSaving(true);
      setVehicleSaveMessage("");
      setVehicleSaveError("");

      const payload = await requestJson("/api/settings/vehicle", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(vehicleForm),
        errorMessage: "Could not save vehicle settings.",
      });

      setVehicleForm({
        year: String(payload.vehicle?.year || ""),
        make: payload.vehicle?.make || "",
        model: payload.vehicle?.model || "",
        trim: payload.vehicle?.trim || "",
        engine: payload.vehicle?.engine || "",
      });
      setVehicleSaveMessage("Vehicle profile saved.");
    } catch (error) {
      setVehicleSaveError(error.message || "Could not save vehicle settings.");
    } finally {
      setVehicleSaving(false);
    }
  }

  async function handleDocumentDefaultsSave(event) {
    event.preventDefault();

    try {
      setDefaultsSaving(true);
      setDefaultsSaveMessage("");
      setDefaultsSaveError("");

      const payload = await requestJson("/api/settings/document-defaults", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          commonSystems: parseLineList(documentDefaultsForm.commonSystemsText),
          documentTypes: parseLineList(documentDefaultsForm.documentTypesText),
        }),
        errorMessage: "Could not save document defaults.",
      });

      const nextDocumentDefaults = {
        commonSystems: payload.documentDefaults?.commonSystems || [],
        documentTypes: payload.documentDefaults?.documentTypes || [],
      };

      setSavedDocumentDefaults(nextDocumentDefaults);
      setDocumentDefaultsForm({
        commonSystemsText: listToTextareaValue(nextDocumentDefaults.commonSystems),
        documentTypesText: listToTextareaValue(nextDocumentDefaults.documentTypes),
      });
      setDefaultsSaveMessage("Document defaults saved.");
    } catch (error) {
      setDefaultsSaveError(error.message || "Could not save document defaults.");
    } finally {
      setDefaultsSaving(false);
    }
  }

  function handleBackupExport() {
    // Stream the download straight from the endpoint via a temporary <a> tag.
    // The server sends Content-Disposition: attachment, so the browser saves the
    // file directly instead of us buffering the whole archive in memory as a Blob.
    setBackupExportError("");

    const link = document.createElement("a");
    link.href = "/api/settings/backup-export";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setBackupExportMessage(
      "Backup download started. Save the .tar.gz file somewhere safe on your computer."
    );
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Manage the Corolla profile saved in this app, keep reusable document labels ready for uploads, and review the local paths this computer is using."
      />

      {loading ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
          Loading settings...
        </section>
      ) : null}

      {loadError ? (
        <ErrorBanner title="Could not load settings." className="shadow-sm">
          {loadError}
        </ErrorBanner>
      ) : null}

      {!loading && !loadError ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <div className="space-y-6">
            <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Vehicle profile</h2>
              <p className="mt-1 text-sm text-slate-600">
                This app stores one Corolla profile. Update it here if you want the rest
                of the app to match the car you are working on.
              </p>

              <form className="mt-5 grid gap-4" onSubmit={handleVehicleSave}>
                <div className="grid gap-4 md:grid-cols-2">
                  <TextField
                    label="Year"
                    name="year"
                    value={vehicleForm.year}
                    onChange={handleVehicleChange}
                    required
                    placeholder="2009"
                  />
                  <TextField
                    label="Make"
                    name="make"
                    value={vehicleForm.make}
                    onChange={handleVehicleChange}
                    required
                    placeholder="Toyota"
                  />
                  <TextField
                    label="Model"
                    name="model"
                    value={vehicleForm.model}
                    onChange={handleVehicleChange}
                    required
                    placeholder="Corolla"
                  />
                  <TextField
                    label="Trim"
                    name="trim"
                    value={vehicleForm.trim}
                    onChange={handleVehicleChange}
                    placeholder="LE"
                  />
                </div>

                <TextField
                  label="Engine"
                  name="engine"
                  value={vehicleForm.engine}
                  onChange={handleVehicleChange}
                  placeholder="1.8L"
                />

                {vehicleSaveMessage ? <SuccessBanner>{vehicleSaveMessage}</SuccessBanner> : null}

                {vehicleSaveError ? <ErrorBanner>{vehicleSaveError}</ErrorBanner> : null}

                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={vehicleSaving}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-600"
                  >
                    {vehicleSaving ? "Saving..." : "Save vehicle profile"}
                  </button>
                  <p className="text-xs text-slate-500">Year, make, and model are required.</p>
                </div>
              </form>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Document defaults</h2>
              <p className="mt-1 text-sm text-slate-600">
                Save the common labels you want ready when importing PDFs. These stay on
                this computer only and show up as suggestions in the Documents page.
              </p>

              <form className="mt-5 grid gap-4" onSubmit={handleDocumentDefaultsSave}>
                <div className="grid gap-4 md:grid-cols-2">
                  <TextAreaField
                    label="Common system names"
                    name="commonSystemsText"
                    value={documentDefaultsForm.commonSystemsText}
                    onChange={handleDocumentDefaultsChange}
                    placeholder={"Engine\nBrakes\nElectrical"}
                    helpText="One item per line. Blank lines and duplicates are ignored."
                  />
                  <TextAreaField
                    label="Common document types"
                    name="documentTypesText"
                    value={documentDefaultsForm.documentTypesText}
                    onChange={handleDocumentDefaultsChange}
                    placeholder={"Repair Manual\nWiring Diagram\nInspection"}
                    helpText="One item per line. Keep names simple so search and filters stay tidy."
                  />
                </div>

                {defaultsSaveMessage ? <SuccessBanner>{defaultsSaveMessage}</SuccessBanner> : null}

                {defaultsSaveError ? <ErrorBanner>{defaultsSaveError}</ErrorBanner> : null}

                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={defaultsSaving}
                    className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-600"
                  >
                    {defaultsSaving ? "Saving..." : "Save document defaults"}
                  </button>
                  <p className="text-xs text-slate-500">
                    These lists are stored in the local app database only.
                  </p>
                </div>
              </form>

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <SavedListPreview
                  label="Saved systems"
                  items={savedDocumentDefaults.commonSystems}
                  emptyMessage="No common systems saved yet."
                />
                <SavedListPreview
                  label="Saved document types"
                  items={savedDocumentDefaults.documentTypes}
                  emptyMessage="No document types saved yet."
                />
              </div>
            </section>
          </div>

          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Local app info</h2>
            <p className="mt-1 text-sm text-slate-600">
              These values come from the local server config and your optional{" "}
              <code>.env</code> file. They are shown for reference only so the browser
              does not accidentally break local paths.
            </p>

            {runtime ? (
              <div className="mt-5 space-y-3">
                <RuntimeRow
                  label="Database file"
                  value={runtime.databaseFile}
                  helpText="This is the SQLite file the app uses for saved records and settings."
                />
                <RuntimeRow
                  label="Uploads folder"
                  value={runtime.uploadsDir}
                  helpText="Uploaded PDF files are copied into this folder."
                />
                <RuntimeRow
                  label="Upload size limit"
                  value={`${runtime.maxUploadSizeMb} MB`}
                  helpText="PDF uploads larger than this are rejected by the server."
                />
                <RuntimeRow
                  label="Server port"
                  value={String(runtime.port)}
                  helpText="This is the local port used by the Express API."
                />
                <RuntimeRow
                  label="Client port"
                  value={String(runtime.clientPort)}
                  helpText="This is the local port used by the Vite frontend during development."
                />
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-600">Runtime details are not available.</p>
            )}

            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">Backup and export</p>

              {backupExport.supported ? (
                <div className="mt-3 space-y-3">
                  <p className="text-sm text-amber-800">
                    {backupExport.message || emptyBackupExport.message}
                  </p>
                  <button
                    type="button"
                    onClick={handleBackupExport}
                    className="rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-600"
                  >
                    Export backup (.tar.gz)
                  </button>
                  {backupExportMessage ? <SuccessBanner>{backupExportMessage}</SuccessBanner> : null}
                  {backupExportError ? <ErrorBanner>{backupExportError}</ErrorBanner> : null}
                </div>
              ) : (
                <p className="mt-2 text-sm text-amber-800">
                  {backupExport.message || emptyBackupExport.message}
                </p>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

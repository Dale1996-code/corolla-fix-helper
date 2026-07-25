// Shared form field components. Previously copy-pasted per page (six copies of
// TextField, five of TextAreaField/SelectField), which let styling drift:
// different radii, focus rings, and textarea heights across pages that were
// otherwise identical. One copy here keeps that from happening again.

import { forwardRef } from "react";

const FIELD_CLASS =
  "rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100";

// forwardRef so callers can focus the input programmatically (e.g. moving
// focus into an edit form when it opens).
export const TextField = forwardRef(function TextField(
  { label, name, value, onChange, required = false, placeholder = "", listId = "" },
  ref
) {
  return (
    <label className="grid gap-2 text-sm text-slate-700">
      <span className="font-medium text-slate-900">
        {label}
        {required ? " *" : ""}
      </span>
      <input
        ref={ref}
        className={FIELD_CLASS}
        name={name}
        value={value}
        onChange={onChange}
        required={required}
        placeholder={placeholder}
        list={listId || undefined}
      />
    </label>
  );
});

export function TextAreaField({ label, name, value, onChange, placeholder = "", helpText = "" }) {
  return (
    <label className="grid gap-2 text-sm text-slate-700">
      <span className="font-medium text-slate-900">{label}</span>
      <textarea
        className={`min-h-28 ${FIELD_CLASS}`}
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
      />
      {helpText ? <span className="text-xs text-slate-500">{helpText}</span> : null}
    </label>
  );
}

// `options` is always [{ value, label }]. Pass `emptyOption` (a label string)
// for a leading blank/"All ..." choice — used by filter selects.
export function SelectField({ label, name, value, onChange, options, emptyOption = "" }) {
  return (
    <label className="grid gap-2 text-sm text-slate-700">
      <span className="font-medium text-slate-900">{label}</span>
      <select className={FIELD_CLASS} name={name} value={value} onChange={onChange}>
        {emptyOption ? <option value="">{emptyOption}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SuggestionDatalist({ id, options }) {
  if (!options.length) {
    return null;
  }

  return (
    <datalist id={id}>
      {options.map((option) => (
        <option key={option} value={option} />
      ))}
    </datalist>
  );
}

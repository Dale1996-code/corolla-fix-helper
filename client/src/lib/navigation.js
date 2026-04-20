export const navigationItems = [
  { label: "Dashboard", to: "/dashboard" },
  { label: "Documents", to: "/documents" },
  { label: "Document Search", to: "/search" },
  { label: "Symptoms", to: "/symptoms" },
  { label: "Procedures", to: "/procedures" },
  { label: "Notes", to: "/notes" },
  { label: "Settings", to: "/settings" },
];

export function buildEntityLink(entityType, entityId) {
  if (!entityId) {
    return "/dashboard";
  }

  if (entityType === "document") {
    return `/documents?documentId=${entityId}#document-library`;
  }

  if (entityType === "symptom") {
    return `/symptoms?symptomId=${entityId}#symptom-library`;
  }

  if (entityType === "procedure") {
    return `/procedures?procedureId=${entityId}#procedure-library`;
  }

  if (entityType === "note") {
    return `/notes?noteId=${entityId}#note-library`;
  }

  return "/dashboard";
}

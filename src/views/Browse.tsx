import { Fragment } from "hono/jsx";
import {
  type BrowseEntry,
  formatFileSize,
  parentRel,
} from "../server/browse.js";

type Crumb = { label: string; href: string };

const FolderIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2z" />
  </svg>
);

const FileIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
  </svg>
);

const browseHref = (rel: string): string =>
  rel === "" ? "/browse" : `/browse/${rel}`;

// A file link points at /files so the browser opens or downloads the bytes
// directly, outside the htmx detail-pane swap.
const fileHref = (rel: string, name: string): string =>
  rel === "" ? `/files/${name}` : `/files/${rel}/${name}`;

const BrowseRow = ({ entry, rel }: { entry: BrowseEntry; rel: string }) => {
  if (entry.isDir) {
    const href = browseHref(rel === "" ? entry.name : `${rel}/${entry.name}`);
    return (
      <li class="browse-entry browse-entry-folder">
        <a
          class="browse-entry-link"
          href={href}
          hx-get={href}
          hx-target="#detail-pane"
          hx-swap="innerHTML"
          hx-push-url="true"
        >
          <span class="browse-entry-icon">
            <FolderIcon />
          </span>
          <span class="browse-entry-name">{entry.name}</span>
          <span class="browse-entry-meta">Folder</span>
        </a>
      </li>
    );
  }
  const href = fileHref(rel, entry.name);
  return (
    <li class="browse-entry browse-entry-file">
      <a class="browse-entry-link" href={href} title={entry.name}>
        <span class="browse-entry-icon">
          <FileIcon />
        </span>
        <span class="browse-entry-name">{entry.name}</span>
        <span class="browse-entry-meta">{formatFileSize(entry.size)}</span>
      </a>
    </li>
  );
};

// Renders a navigable directory listing: a path breadcrumb, a ".." parent link
// when not at the root, and entries sorted with folders first.
const BrowseDetail = ({
  rel,
  segments,
  entries,
}: {
  rel: string;
  segments: string[];
  entries: BrowseEntry[];
}) => {
  const crumbs: Crumb[] = [{ label: "~", href: "/browse" }];
  let acc = "";
  for (const seg of segments) {
    acc = acc === "" ? seg : `${acc}/${seg}`;
    crumbs.push({ label: seg, href: `/browse/${acc}` });
  }
  const up = parentRel(rel);
  return (
    <div class="detail-inner browse">
      <div class="browse-head">
        <h2>Browse files</h2>
        <nav class="browse-breadcrumb" aria-label="Directory path">
          {crumbs.map((crumb, i) => (
            <Fragment>
              {i > 0 && (
                <span class="browse-crumb-sep" aria-hidden="true">
                  /
                </span>
              )}
              <a
                class="browse-crumb"
                href={crumb.href}
                hx-get={crumb.href}
                hx-target="#detail-pane"
                hx-swap="innerHTML"
                hx-push-url="true"
              >
                {crumb.label}
              </a>
            </Fragment>
          ))}
        </nav>
      </div>
      {entries.length === 0 && rel === "" && (
        <p class="browse-empty">Your home directory has nothing to show.</p>
      )}
      {entries.length === 0 && rel !== "" && (
        <p class="browse-empty">This folder is empty.</p>
      )}
      {entries.length > 0 && (
        <ul class="browse-list">
          {rel !== "" && (
            <li class="browse-entry browse-entry-parent">
              <a
                class="browse-entry-link"
                href={browseHref(up)}
                hx-get={browseHref(up)}
                hx-target="#detail-pane"
                hx-swap="innerHTML"
                hx-push-url="true"
              >
                <span class="browse-entry-icon">
                  <FolderIcon />
                </span>
                <span class="browse-entry-name">..</span>
                <span class="browse-entry-meta">Up one level</span>
              </a>
            </li>
          )}
          {entries.map((entry) => (
            <BrowseRow entry={entry} rel={rel} />
          ))}
        </ul>
      )}
    </div>
  );
};

const BrowseError = ({ status }: { status: number }) => (
  <div class="placeholder">
    <h2>Folder not available</h2>
    <p>
      That path is outside your home directory, hidden, or missing
      {status === 400 ? " (bad request)" : ""}.
    </p>
  </div>
);

export { BrowseDetail, BrowseError };

const refetchPicker = (select: HTMLSelectElement): void => {
  const form = select.form;
  if (form === null || form === undefined) return;
  const wrap = form.querySelector<HTMLElement>("[data-model-picker-wrap]");
  if (wrap === null) return;
  const query = new URLSearchParams({ agent: select.value });
  const submitted = form.querySelector<HTMLSelectElement>(
    "select[name=model_provider]",
  );
  if (submitted !== null && submitted.value !== "")
    query.set("submitted", submitted.value);
  void fetch(`/sessions/model-picker?${query.toString()}`)
    .then(async (res) => {
      wrap.innerHTML = await res.text();
    })
    .catch(() => undefined);
};

// Agent picker behaviour for the New Session form: changing the agent
// re-fetches the model picker for the newly picked agent, because the
// picker (and model support itself) is per agent — goose offers its
// configured models, claude none. The wrap element is the stable swap
// target; the server fragment replaces whatever it currently holds.
const init = (root: ParentNode): void => {
  for (const select of root.querySelectorAll<HTMLSelectElement>(
    "select[name=agent]",
  ))
    select.addEventListener("change", () => refetchPicker(select));
};

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => init(document));
else init(document);

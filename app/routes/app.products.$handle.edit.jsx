import { useState, useEffect, useRef } from "react";
import { useLoaderData, useActionData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
const GQL_GET_PRODUCT = `#graphql
  query GetProduct($query: String!) {
    products(first: 1, query: $query) {
      edges {
        node {
        id,title
          media(first: 20) {
            edges { node { ... on MediaImage { id image { url altText } } } }
          }
          variants(first: 100) {
            edges {
              node {
                id price
                selectedOptions { name value }
                media(first: 1) {
                  edges { node { ... on MediaImage { id image { url altText } } } }
                }
                inventoryItem {
                  sku
                  measurement { weight { value unit } }
                }
              }
            }
          }
        }
      }
    }
  }`;
const GQL_GET_METAFIELDS = `#graphql
  query GetMetafields($query: String!) {
    products(first: 1, query: $query) {
      edges {
        node {
          metafields(first: 50) {
            edges { node { id namespace key value type } }
          }
        }
      }
    }
  }`;
const GQL_UPDATE_VARIANTS = `#graphql
  mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku price selectedOptions{name value}media(first: 1) {edges { node { ... on MediaImage { id image { url altText } } } }
        } }
      userErrors { field message }
    }
  }`;
const GQL_UPSERT_METAFIELDS = `#graphql
  mutation SaveMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value }
      userErrors { field message code }
    }
  }`;
const GQL_DELETE_METAFIELDS = `#graphql
  mutation DeleteMetafields($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { ownerId namespace key }
      userErrors { field message }
    }
  }`;
//Loader
export const loader = async ({ request, params }) => {
  const { handle } = params;
  if (!handle) throw new Response("Handle is required to load product", { status: 400 });
  const { admin, session } = await authenticate.admin(request);
  if (!session || !admin) { throw new Response("Unauthorized session", { status: 401 }); }
  const tab = new URL(request.url).searchParams.get("tab");
  if (!["variants", "metafields", null].includes(tab)) { return Response.json({ error: "Unsupported tab" }); }
  if (tab === "metafields") {
    try {
      const res = await admin.graphql(GQL_GET_METAFIELDS, { variables: { query: `handle:${handle}` } });
      const data = await res.json();
      const node = data?.data?.products?.edges?.[0]?.node;
      if (!node) return Response.json({ error: "Unable to load metafield data right now.Please try again.. " });
      const metafields = node.metafields.edges.map(({ node: mf }) => ({
        id: mf.id,
        namespace: mf.namespace,
        key: mf.key,
        value: mf.value,
        type: mf.type,
      }));
      return Response.json({ metafields });
    } catch {
      return Response.json({ error: "Unable to load metafield data right now.Please try again." });
    }
  }
  const res = await admin.graphql(GQL_GET_PRODUCT, { variables: { query: `handle:${handle}` } });
  const data = await res.json();
  const raw = data?.data?.products?.edges?.[0]?.node;
  if (!raw) throw new Response("Product not found", { status: 404 });
  const variants = raw.variants.edges.map(({ node }) => ({
    id: node.id,
    sku: node.inventoryItem?.sku || "",
    price: node.price || "0.00",
    weight: node.inventoryItem?.measurement?.weight?.value != null
      ? String(node.inventoryItem.measurement.weight.value) : "",
    weightUnit: node.inventoryItem?.measurement?.weight?.unit || "KILOGRAMS",
    selectedOptions: node.selectedOptions || [],
    optionValue: node.selectedOptions?.[0]?.value || "",
    mediaId: node.media?.edges?.[0]?.node?.id || "",
    imageUrl: node.media?.edges?.[0]?.node?.image?.url || null,
  }));
  const mediaImages = raw.media.edges
    .filter(({ node }) => node.id)
    .map(({ node }) => ({
      id: node.id,
      url: node.image?.url || "",
      altText: node.image?.altText || "",
    }));
  return Response.json({
    product: {
      id: raw.id,
      handle,
      title: raw.title,
      variants,
      mediaImages,
    },
  });
};
//ACTION
export const action = async ({ request, params }) => {
  const { handle } = params;
  if (!handle) return Response.json({ error: "Handle is required to update product" }, { status: 400 });
  const { admin, session } = await authenticate.admin(request);
  if (!session && !admin) { throw new Response("Unauthorized session", { status: 401 }); }
  let formData;
  try { formData = await request.formData(); }
  catch { return Response.json({ error: "Invalid product payload" }, { status: 400 }); }
  const productId = formData.get("productId");
  if (!productId) return Response.json({ error: "Invalid product payload" }, { status: 400 });
  let variants, metafieldsToUpsert, metafieldsToDelete;
  try {
    variants = JSON.parse(formData.get("variants") || "[]");
    metafieldsToUpsert = JSON.parse(formData.get("metafieldsToUpsert") || "[]");
    metafieldsToDelete = JSON.parse(formData.get("metafieldsToDelete") || "[]");
  } catch {
    return Response.json({ error: "Invalid product payload" }, { status: 400 });
  }
   const changedVariants = variants;
  const productRes = await admin.graphql(GQL_GET_PRODUCT, {
    variables: { query: `id:${productId}` }
  });
  const productData = await productRes.json();
  const allVariants = productData?.data?.products?.edges?.[0]?.node?.variants?.edges?.map(
    ({ node }) => ({ id: node.id, sku: node.inventoryItem?.sku || "" })
  ) || [];
  for (const variant of changedVariants) {
    const sku = variant.sku?.trim();
    if (!sku) continue;
    const duplicate = allVariants.find(
      (existing) => existing.sku?.trim() === sku && existing.id !== variant.id
    );
    if (duplicate) {
      return Response.json({ error: `SKU "${sku}" is already used by another variant.` });
    }
  }
  if (changedVariants.length > 0) {
    const variantInputs = changedVariants.map((v) => {
      const input = { id: v.id, };
      if (v.price !== undefined) { input.price = v.price; }
      if (v.mediaId !== undefined) { input.mediaId = v.mediaId || null; }
      if (v.selectedOptions !== undefined && v.selectedOptions.length > 0) {
        input.optionValues = v.selectedOptions.map((o) => ({ optionName: o.name, name: o.value, }));
      }
      if (v.sku !== undefined || v.weight !== undefined) { input.inventoryItem = {}; }
      if (v.sku !== undefined) { input.inventoryItem.sku = v.sku; }
      if (v.weight !== undefined && v.weight !== "" && !isNaN(parseFloat(v.weight))) {
        input.inventoryItem.measurement = {
          weight: {
            value: parseFloat(v.weight),
            unit: v.weightUnit || "KILOGRAMS",
          },
        };
      }
      return input;
    });
    try {
      console.log("Calling GQL_UPDATE_VARIANTS");
      const res = await admin.graphql(GQL_UPDATE_VARIANTS, {
        variables: { productId, variants: variantInputs },
      });
      const data = await res.json();
      if (data.errors?.length) { return Response.json({ error: "Unable to update product right now. Please try again." }); }
      const errors = data?.data?.productVariantsBulkUpdate?.userErrors || [];
      if (errors.length) return Response.json({ error: errors[0].message });
    } catch { return Response.json({ error: "Unable to update product right now. Please try again." }); }

  }
  if (metafieldsToDelete.length > 0) {
    const identifiers = metafieldsToDelete.map(({ ownerId, namespace, key }) => ({ ownerId, namespace, key }));
    try {
      console.log("Calling GQL_DELETE_METAFIELDS");
      const res = await admin.graphql(GQL_DELETE_METAFIELDS, { variables: { metafields: identifiers } });
      const data = await res.json();
      if (data.errors?.length) { return Response.json({ error: "Unable to update product right now. Please try again." }); }
      const errors = data?.data?.metafieldsDelete?.userErrors || [];
      if (errors.length) return Response.json({ error: errors[0].message });
    } catch { return Response.json({ error: "Unable to update product right now. Please try again." }); }
  }
  if (metafieldsToUpsert.length > 0) {
    const metafields = metafieldsToUpsert.map(({ namespace, key, value, type }) => ({
      ownerId: productId, namespace, key, value: String(value), type,
    }));
    try {
      console.log("Calling GQL_UPSERT_METAFIELDS");
      const res = await admin.graphql(GQL_UPSERT_METAFIELDS, { variables: { metafields } });
      const data = await res.json();
      const errors = data?.data?.metafieldsSet?.userErrors || [];
      if (errors.length) return Response.json({ error: errors[0].message });
    } catch { return Response.json({ error: "Unable to update product right now. Please try again." }); }

  }
  const nothingChanged =
    changedVariants.length === 0 &&
    metafieldsToDelete.length === 0 &&
    metafieldsToUpsert.length === 0;
  if (nothingChanged) {
    return Response.json({
      success: true,
      noop: true,
    });
  }
  return Response.json({
    success: true
  });
}
// MAIN COMPONENT
export default function ProductEditPage() {
  const { product } = useLoaderData();
  const actionData = useActionData();
  const fetcher = useFetcher();
  const metaFetcher = useFetcher();
  const [activeTab, setActiveTab] = useState("variants");
  const [state, setState] = useState({
    variants: product.variants.map((v) => ({ ...v })),
    metafields: null,
  });
  const originalRef = useRef({
    variants: product.variants.map((v) => ({ ...v })),
    metafields: null,
  });
  const [deletedMetas, setDeletedMetas] = useState([]);
  const [errors, setErrors] = useState({});
  useEffect(() => {
    if (activeTab === "metafields" && state.metafields === null && metaFetcher.state === "idle") {
      metaFetcher.load(`/app/products/${product.handle}/edit?tab=metafields`);
    }
  }, [activeTab]);
  useEffect(() => {
    if (metaFetcher.data?.metafields) {
      const loaded = metaFetcher.data.metafields.map((mf) => ({ ...mf, _dirty: false, _pendingDelete: false }));
      setState((prev) => ({ ...prev, metafields: loaded }));
      originalRef.current = { ...originalRef.current, metafields: loaded.map((mf) => ({ ...mf })) };
    }
  }, [metaFetcher.data]);
  useEffect(() => {
    if (!fetcher.data?.success || fetcher.data?.noop) return;
    originalRef.current = {
      variants: state.variants.map((v) => ({ ...v })),
      metafields: state.metafields
        ? state.metafields.filter((mf) => !mf._pendingDelete).map((mf) => ({ ...mf, _dirty: false }))
        : null,
    };
    setState((prev) => ({
      ...prev,
      metafields: prev.metafields
        ? prev.metafields.filter((mf) => !mf._pendingDelete).map((mf) => ({ ...mf, _dirty: false }))
        : null,
    }));
    setDeletedMetas([]);
    setErrors({});
  }, [fetcher.data]);
  function updateVariant(variantId, field, value) {
    setState((prev) => ({
      ...prev,
      variants: prev.variants.map((v) => v.id === variantId ? { ...v, [field]: value } : v),
    }));
    const idx = state.variants.findIndex((v) => v.id === variantId);
    setErrors((prev) => { const next = { ...prev }; delete next[`${field}-${idx}`]; return next; });
  }
  function updateVariantOption(variantId, optIdx, value) {
    setState((prev) => ({
      ...prev,
      variants: prev.variants.map((v) => {
        if (v.id !== variantId) return v;
        const updatedOptions = v.selectedOptions.map((o, i) =>
          i === optIdx ? { ...o, value } : o
        );
        return { ...v, selectedOptions: updatedOptions };
      }),
    }));
    const idx = state.variants.findIndex((v) => v.id === variantId);
    setErrors((prev) => { const next = { ...prev }; delete next[`optionValue-${idx}`]; return next; });
  }
  function updateMetafield(idx, field, value) {
    const cleaned = (field === "namespace" || field === "key")
      ? value.toLowerCase().replace(/\s/g, "")
      : value;
    setState((prev) => ({
      ...prev,
      metafields: prev.metafields.map((mf, i) =>
        i === idx ? { ...mf, [field]: cleaned, _dirty: true } : mf
      ),
    }));
    setErrors((prev) => { const next = { ...prev }; delete next[`${field}-${idx}`]; return next; });
  }
  function addMetafield() {
    setState((prev) => ({
      ...prev,
      metafields: [
        ...(prev.metafields || []),
        { id: null, namespace: "custom", key: "", value: "", type: "single_line_text_field", _dirty: true, _pendingDelete: false },
      ],
    }));
  }
  function deleteMetafield(idx) {
    const mf = state.metafields[idx];
    if (!mf.id) {
      setState((prev) => ({ ...prev, metafields: prev.metafields.filter((_, i) => i !== idx) }));
      return;
    }
    setState((prev) => ({
      ...prev,
      metafields: prev.metafields.map((m, i) => i === idx ? { ...m, _pendingDelete: true } : m),
    }));
    setDeletedMetas((prev) => [...prev, { ownerId: product.id, namespace: mf.namespace, key: mf.key }]);
  }
  function undoDeleteMetafield(idx) {
    const mf = state.metafields[idx];
    setState((prev) => ({
      ...prev,
      metafields: prev.metafields.map((m, i) => i === idx ? { ...m, _pendingDelete: false } : m),
    }));
    setDeletedMetas((prev) => prev.filter((d) => !(d.namespace === mf.namespace && d.key === mf.key)));
  }
  function handleDiscard() {
    const orig = originalRef.current;
    setState({
      variants: orig.variants.map((v) => ({ ...v })),
      metafields: orig.metafields
        ? orig.metafields.map((mf) => ({ ...mf, _dirty: false, _pendingDelete: false }))
        : null,
    });
    setDeletedMetas([]);
    setErrors({});
  }
  function validate() {
    const newErrors = {};
    state.variants.forEach((v, idx) => {
      const priceRegex = /^\d+(\.\d{1,2})$/;
      const isPriceValid = priceRegex.test(v.price) && parseFloat(v.price) >= 0;
      const isWeightValid = v.weight === "" || (!isNaN(parseFloat(v.weight)) && parseFloat(v.weight) > 0);
      const skuList = state.variants.map((v) => v.sku?.trim()).filter(Boolean);
      const skuDupes = skuList.filter((sku, i) => skuList.indexOf(sku) !== i);
      if (skuDupes.length > 0) {
        if (skuDupes.includes(v.sku?.trim())) {
          newErrors[`sku-${idx}`] = `SKU '${v.sku}' is duplicated within this product.`;
        }
      };
      if ((v.selectedOptions || []).some((o) => !o.value?.trim())) { newErrors[`optionValue-${idx}`] = "Option value is required."; }
      if (!v.price) {
        newErrors[`price-${idx}`] = "Price is required.";
      } else if (!isPriceValid) {
        newErrors[`price-${idx}`] = "Price must be like 9.99";
      }
      if (!isWeightValid) { newErrors[`weight-${idx}`] = "Weight must be a positive number."; }

    });
    (state.metafields || []).forEach((mf, idx) => {
      if (!mf._dirty || mf._pendingDelete) return;
      if (!mf.namespace?.trim()) { newErrors[`namespace-${idx}`] = "Namespace is required."; }
      if (!mf.key?.trim()) { newErrors[`key-${idx}`] = "Key is required."; }
      const value = mf.value?.trim();
      let isValid = true;
      if (!value) {
        isValid = false;
      } else {
        if (mf.type === "integer") { isValid = /^-?\d+$/.test(value); }
        if (mf.type === "boolean") { isValid = ["true", "false"].includes(value); }
        if (mf.type === "json") { try { JSON.parse(value); isValid = true; } catch { isValid = false } }
      }
      if (!isValid) { newErrors[`value-${idx}`] = value ? `Value does not match type "${mf.type}".` : "Value is required."; }
    });
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }
  function computeVariantDiff() {
    return state.variants.map((v) => {
        const orig = originalRef.current.variants.find((o) => o.id === v.id);
        if (!orig) return v;
        const diff = { id: v.id, };
        if (v.price !== orig.price) { diff.price = v.price; }
        if (v.sku !== orig.sku) { diff.sku = v.sku; }
        if (v.weight !== orig.weight) { diff.weight = v.weight; diff.weightUnit = v.weightUnit; }
        if (v.mediaId !== orig.mediaId) { diff.mediaId = v.mediaId; }
        const origOptions = JSON.stringify(orig.selectedOptions || []);
        const currOptions = JSON.stringify(v.selectedOptions || []);
        if (currOptions !== origOptions) {
          diff.selectedOptions = v.selectedOptions;
        }
        return Object.keys(diff).length > 1 ? diff : null;
      }).filter(Boolean);
  }
  function getIsDirty(state, original) {
    for (const v of state.variants) {
      const orig = original.variants.find((o) => o.id === v.id);
      if (!orig) return true;
      if (["price", "sku", "weight", "mediaId", "optionValue"].some((f) => v[f] !== orig[f])) return true;
      if (JSON.stringify(v.selectedOptions) !== JSON.stringify(orig.selectedOptions)) return true;
    }
    if (state.metafields !== null) {
      const hasDirtyMeta = state.metafields.some((mf) => mf._dirty || mf._pendingDelete);
      if (hasDirtyMeta) return true;
    }
    return false;
  }
  //SAVE 
  function handleSave() {
    if (!validate()) return;
    const toUpsert = (state.metafields || [])
      .filter((mf) => mf._dirty && !mf._pendingDelete)
      .map(({ namespace, key, value, type }) => ({ namespace, key, value, type }));
    const changedVariants = computeVariantDiff();
    console.log("Changed Variants:", changedVariants);
    fetcher.submit(
      {
        productId: product.id,
        variants: JSON.stringify(changedVariants),
        metafieldsToUpsert: JSON.stringify(toUpsert),
        metafieldsToDelete: JSON.stringify(deletedMetas),
      },
      { method: "POST" }
    );
  }
  const isDirty = getIsDirty(state, originalRef.current) || deletedMetas.length > 0;
  const isSaving = fetcher.state === "submitting" || fetcher.state === "loading";
  const saveResult = fetcher.data;
  // RENDER
  return (
    <div style={S.page}>
      <div style={S.headerBar}>
        <h1 style={S.pageTitle}> {product.title}</h1>
        <div style={S.headerActions}>
          {isSaving && <span style={S.statusMsg}>Saving…</span>}
          {!isSaving && saveResult?.success && !saveResult?.noop && (
            <span style={{ ...S.statusMsg, color: "green" }}> Saved!</span>
          )}
          {!isSaving && saveResult?.error && (
            <span style={{ ...S.statusMsg, color: "red" }}> {saveResult.error}</span>
          )}
          {!isSaving && actionData?.error && (
            <span style={{ ...S.statusMsg, color: "red" }}> {actionData.error}</span>
          )}
          {!["variants", "metafields"].includes(activeTab) && (
            <span style={{ ...S.statusMsg, color: "red" }}>Unsupported tab</span>
          )}
          <LabelButton label="Discard" onClick={handleDiscard} disabled={!isDirty || isSaving} style={S.btnDiscard} />
         <LabelButton label={isSaving ? "Saving…" : "Save"} onClick={handleSave} disabled={!isDirty || isSaving} style={S.btnSave} />
          {!isSaving && !isDirty && !saveResult?.error && !actionData?.error && (
            <span style={{ ...S.statusMsg, color: "#888" }}>No changes to save.</span>
          )} 
        </div>
      </div>
      <div style={S.tabs}>
        <TabButton active={activeTab === "variants"} onClick={() => setActiveTab("variants")}>
          Variants
        </TabButton>
        <TabButton active={activeTab === "metafields"} onClick={() => setActiveTab("metafields")}>
          Metafields
        </TabButton>
        <TabButton active={activeTab === "basic"} onClick={() => setActiveTab("basic")}>
          Basic
        </TabButton>
      </div>
      {activeTab === "variants" && (
        <div style={S.card}>
          <h2 style={S.sectionTitle}>Variants</h2>
          <p style={{ marginBottom: 10, fontWeight: "bold" }}>Total Variants: {state.variants.length}</p>
          <div style={{ overflowX: "auto" }}>
            <table style={S.table}>
              <thead>
                <tr style={{ backgroundColor: "#f5f5f5" }}>
                  {[" Option Name*", "Option Value* ", "Price*", "SKU", "Weight", "Image"].map((h) => (
                    <th key={h} style={h === "Varient" ? { ...S.th, ...S.varientCol } : S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.variants.map((v, idx) => (
                  <tr key={v.id} style={{ borderBottom: "1px solid #eee" }}>
                    <td style={S.td}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {v.selectedOptions?.map((o, optIdx) => (
                          <span key={optIdx} style={S.option}>
                            {o.name || "—"}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td style={S.td}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {v.selectedOptions?.map((o, optIdx) => {
                          const isSize = o.name?.trim().toLowerCase() === "size";
                          return (
                            <div key={optIdx}>
                              {isSize ? (
                                <select
                                  value={o.value}
                                  onChange={(e) => updateVariantOption(v.id, optIdx, e.target.value)}
                                  style={S.optionValue}
                                >
                                  <option value="">— pick —</option>
                                  {["XS", "S", "M", "L", "XL", "XXL"].map((s) => (
                                    <option key={s} value={s}>{s}</option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  value={o.value}
                                  onChange={(e) => updateVariantOption(v.id, optIdx, e.target.value)}
                                  placeholder="e.g. Red"
                                  style={S.optionValue}
                                />
                              )}
                            </div>
                          );
                        })}
                        {errors[`optionValue-${idx}`] && <Err>{errors[`optionValue-${idx}`]}</Err>}
                      </div>
                    </td>
                    <td style={S.td}>
                      <input
                        type="text"
                        value={v.price}
                        onChange={(e) => updateVariant(v.id, "price", e.target.value)}
                        placeholder="0.00"
                        style={{ ...S.input, width: 90 }}
                      />
                      {errors[`price-${idx}`] && <Err>{errors[`price-${idx}`]}</Err>}
                    </td>
                    <td style={S.td}>
                      <input
                        type="text"
                        value={v.sku}
                        onChange={(e) => updateVariant(v.id, "sku", e.target.value)}
                        placeholder="e.g. SHIRT-RED-M"
                        style={{ ...S.input, width: 130 }}
                      />
                      {errors[`sku-${idx}`] && <Err>{errors[`sku-${idx}`]}</Err>}
                    </td>
                    <td style={S.td}>
                      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          value={v.weight}
                          onChange={(e) => updateVariant(v.id, "weight", e.target.value)}
                          placeholder="0"
                          style={{ ...S.input, width: 70 }}
                        />
                        <span style={{ fontSize: 12, color: "#888" }}>
                          {v.weightUnit === "KILOGRAMS" ? "kg" : "lb"}
                        </span>
                      </div>
                      {errors[`weight-${idx}`] && <Err>{errors[`weight-${idx}`]}</Err>}
                    </td>
                    <td style={S.td}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {v.imageUrl
                          ? <img src={v.imageUrl} alt="" style={S.thumb} />
                          : <div style={S.thumbEmpty}>IMG</div>
                        }
                        <select
                          value={v.mediaId}
                          onChange={(e) => {
                            const found = product.mediaImages.find((m) => m.id === e.target.value);
                            updateVariant(v.id, "mediaId", e.target.value);
                            updateVariant(v.id, "imageUrl", found?.url || null);
                          }}
                          style={{ ...S.input, width: 130 }}
                        >
                          <option value="">No image</option>
                          {product.mediaImages.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.altText || m.id.split("/").pop()}
                            </option>
                          ))}
                        </select>
                      </div>
                      {errors[`mediaId-${idx}`] && <Err>{errors[`mediaId-${idx}`]}</Err>}
                    </td>

                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {activeTab === "metafields" && (
        <div style={S.card}>
          <h2 style={S.sectionTitle}>Metafields</h2>
          {metaFetcher.state === "loading" && (
            <p style={{ color: "#888" }}> ⌛Loading metafields…</p>
          )}
          {metaFetcher.data?.error && (
            <div style={S.errorBanner}>{metaFetcher.data.error}</div>
          )}
          {state.metafields !== null && state.metafields.length === 0 && (
            <p style={{ color: "#888" }}>No metafields yet. Click "Add Metafield" below.</p>
          )}
          {state.metafields !== null && state.metafields.length > 0 && (
            <>
              <div style={S.mfHeader}>
                <span>Namespace*</span>
                <span>Key* </span>
                <span>Value* </span>
                <span>Type</span>
                <span></span>
              </div>
              {state.metafields.map((mf, idx) => (
                <div
                  key={mf.id || `new-${idx}`}
                  style={{
                    ...S.mfRow,
                    backgroundColor: mf._pendingDelete ? "#fff0f0" : mf._dirty ? "#fffde7" : "white",
                    border: `1px solid ${mf._pendingDelete ? "#f44336" : mf._dirty ? "#ffe082" : "#e0e0e0"}`,
                    opacity: mf._pendingDelete ? 0.65 : 1,
                  }}
                >
                  <div>
                    <input
                      type="text"
                      value={mf.namespace}
                      placeholder="custom"
                      disabled={mf._pendingDelete}
                      onChange={(e) => updateMetafield(idx, "namespace", e.target.value)}
                      style={{ ...S.input, textDecoration: mf._pendingDelete ? "line-through" : "none" }}
                    />
                    {errors[`namespace-${idx}`] && <Err>{errors[`namespace-${idx}`]}</Err>}
                  </div>
                  <div>
                    <input
                      type="text"
                      value={mf.key}
                      placeholder="my_field"
                      disabled={mf._pendingDelete}
                      onChange={(e) => updateMetafield(idx, "key", e.target.value)}
                      style={{ ...S.input, textDecoration: mf._pendingDelete ? "line-through" : "none" }}
                    />
                    {errors[`key-${idx}`] && <Err>{errors[`key-${idx}`]}</Err>}
                  </div>
                  <div>
                    <input
                      type="text"
                      value={mf.value}
                      placeholder={
                        mf.type === "integer" ? "e.g. 42" :
                          mf.type === "boolean" ? "true or false" :
                            mf.type === "json" ? '{"key":"val"}' : "Text value"
                      }
                      disabled={mf._pendingDelete}
                      onChange={(e) => updateMetafield(idx, "value", e.target.value)}
                      style={{ ...S.input, textDecoration: mf._pendingDelete ? "line-through" : "none" }}
                    />
                    {errors[`value-${idx}`] && <Err>{errors[`value-${idx}`]}</Err>}
                  </div>
                  <select
                    value={mf.type}
                    disabled={mf._pendingDelete}
                    onChange={(e) => updateMetafield(idx, "type", e.target.value)}
                    style={S.input}
                  >
                    <option value="single_line_text_field">Text</option>
                    <option value="integer">Integer</option>
                    <option value="boolean">Boolean</option>
                    <option value="json">JSON</option>
                  </select>
                  {mf._pendingDelete ? (
                    <button onClick={() => undoDeleteMetafield(idx)} style={S.undoBtn}> Undo</button>
                  ) : (
                    <button onClick={() => deleteMetafield(idx)} style={S.deleteBtn}>DELETE</button>
                  )}
                </div>
              ))}
            </>
          )}
          {state.metafields !== null && (
            <button onClick={addMetafield} style={S.addBtn}>+ Add Metafield</button>
          )}
        </div>
      )}
      {activeTab === "basic" && (
        <div style={S.card}><p style={{ color: "#888" }}>Basic editing is not yet supported.</p></div>
      )}
    </div>
  );
}
function TabButton({ active, onClick, children }) {
  return (<button onClick={onClick} style={{ padding: "10px 22px", backgroundColor: active ? "#008060" : "#e8e8e8", color: active ? "white" : "#333", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: "bold", fontSize: 14, }}>{children} </button>);
}
function LabelButton({ label, onClick, disabled, style }) { 
  return <button onClick={onClick} disabled={disabled} style={{ ...S.btn, ...style, ...(disabled ? S.btnDisabled : {}) }}>{label}</button>; }
function Err({ children }) {
  return <div style={{ color: "red", fontSize: 11, marginTop: 3 }}>{children}</div>;
}
const S = {
  variantCol: { width: "180px", fontWeight: "600", color: "#333", whiteSpace: "nowrap" },
  variantCell: { width: "180px", color: "#444", fontWeight: 500, whiteSpace: "nowrap" },
  page: { padding: "0 0 40px 0", maxWidth: 1000, margin: "0 auto", fontFamily: "Arial, sans-serif", fontSize: 14 },
  headerBar: { position: "sticky", top: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", backgroundColor: "#fff", borderBottom: "1px solid #ddd", boxShadow: "0 2px 6px rgba(0,0,0,0.06)", marginBottom: 20 },
  pageTitle: { margin: 0, fontSize: 20, fontWeight: "bold" },
  headerActions: { display: "flex", alignItems: "center", gap: 12 },
  statusMsg: { fontSize: 13, fontWeight: "bold" },
  btn: { padding: "9px 20px", border: "none", borderRadius: 6, fontWeight: "bold", fontSize: 14, cursor: "pointer" },
  btnSave: { backgroundColor: "#008060", color: "white" },
  btnDiscard: { backgroundColor: "#f0f0f0", color: "#333" },
  btnDisabled: { backgroundColor: "#ddd", color: "#999", cursor: "not-allowed" },
  tabs: { display: "flex", gap: 10, marginBottom: 20, paddingLeft: 20 },
  card: { backgroundColor: "#f9f9f9", padding: 20, borderRadius: 10, border: "1px solid #e0e0e0", margin: "0 20px" },
  sectionTitle: { marginTop: 0, fontSize: 18 },
  input: { width: "100%", padding: "6px 8px", borderRadius: 2, border: "1px solid #050505", fontSize: 14, boxSizing: "border-box" },
  hint: { color: "#888", fontSize: 12 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th: { padding: "8px 10px", textAlign: "left", borderBottom: "2px solid #ddd", whiteSpace: "nowrap" },
  td: { padding: "8px 10px", verticalAlign: "top" },
  thumb: { width: 36, height: 36, objectFit: "cover", borderRadius: 4, border: "1px solid #ddd" },
  thumbEmpty: { width: 36, height: 36, background: "#eee", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#888" },
  mfHeader: { display: "grid", gridTemplateColumns: "1fr 1fr 2fr 120px 60px", gap: 8, padding: "6px 8px", backgroundColor: "#f0f0f0", borderRadius: 4, fontWeight: "bold", fontSize: 13, marginBottom: 6 },
  mfRow: { display: "grid", gridTemplateColumns: "1fr 1fr 2fr 120px 60px", gap: 8, alignItems: "start", padding: 8, borderRadius: 6, marginBottom: 6 },
  deleteBtn: { padding: "6px 8px", backgroundColor: "#d82c0d", color: "white", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 13 },
  undoBtn: { padding: "6px 8px", backgroundColor: "#666", color: "white", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12 },
  addBtn: { marginTop: 14, padding: "8px 16px", backgroundColor: "#f0f0f0", color: "#333", border: "1px solid #ccc", borderRadius: 6, cursor: "pointer", fontWeight: "bold", fontSize: 14 },
  errorBanner: { padding: 10, backgroundColor: "#fff0f0", border: "1px solid red", borderRadius: 6, color: "red", marginBottom: 15, letterSpacing: "0.4px", textTransform: "capitalize" },
  option: { display: "inline-block", padding: "4px 12px", border: " 1px solid black", fontSize: 12, fontWeight: "500", whiteSpace: "nowrap" },
  optionValue: { width: 90, padding: "5px 8px", fontSize: 13, border: " 1px solid black", fontWeight: "600", color: "#333", backgroundColor: "#ffffff", cursor: "pointer", outline: "none" },
}

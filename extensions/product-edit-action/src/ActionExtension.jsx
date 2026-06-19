import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
const APP_HANDLE = "adaptive-venture-app-9";
const STORE_NAME = "amazon-ggbxguwa";
export default async () => {
  render(<Extension />, document.body);
}
function Extension() {
  const { close, data } = shopify;
  const [handle, setHandle] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    (async function getProductHandle() {
      try {
        const productId = data.selected[0].id;
        console.log("Product ID:", productId);
        const query = {
          query: `query GetProduct($id: ID!) {
            product(id: $id) {
              handle
              title
            }
          }`,
          variables: { id: productId },
        };

        const res = await fetch("shopify:admin/api/graphql.json", {
          method: "POST",
          body: JSON.stringify(query),
        });
        const productData = await res.json();
        console.log("GraphQL Response:", productData);
        const productHandle = productData?.data?.product?.handle;
        console.log("Handle found:", productHandle);
        if (productHandle) {
          setHandle(productHandle);
        } else {
          setError("Could not find product handle");
        }
        setLoading(false);
      } catch (err) {
        console.error("Error:", err);
        setError("Failed to load product");
        setLoading(false);
      }
    })();
  }, []);
const handleEditProduct = () => {
  if (!handle) return;
  const editUrl = `https://admin.shopify.com/store/${STORE_NAME}/apps/${APP_HANDLE}/app/products/${handle}/edit`;
  console.log("Navigating to:", editUrl);
  window.open(editUrl, '_top');
  close();
};

  return (
    <s-admin-action>
      <s-stack direction="block">
        {loading && (
          <s-text> Loading product info...</s-text>
        )}
        {error && (
          <s-text> {error}</s-text>
        )}
        {!loading && !error && handle && (
          <s-text>
            Ready to edit: {handle}
          </s-text>
        )}

      </s-stack>
      <s-button
        slot="primary-action"
        disabled={!handle || loading}
        onClick={handleEditProduct}
      >
         Edit Product
      </s-button>
      <s-button
        slot="secondary-actions"
        onClick={() => close()}
      >
        Close
      </s-button>
    </s-admin-action>
  );
}
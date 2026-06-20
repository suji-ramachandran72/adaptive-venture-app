# Overview

This PR enhances the Product Edit page by improving variant and metafield management, adding validations, dirty-state tracking, save/discard functionality, and reusable UI components.

# Changes Made

## Variant Management

* Added support for editing:

  * Price
  * SKU
  * Weight
  * Variant option values
  * Variant images
* Added SKU duplicate validation within the product.
* Added backend SKU uniqueness validation before update.
* Added price and weight validations.
* Implemented variant change detection using `computeVariantDiff()` to submit only modified fields.

## Metafield Management

* Added metafield lazy loading using a separate fetcher.
* Added support for:

  * Create metafields
  * Update metafields
  * Delete metafields
  * Undo delete action
* Added validation for:

  * Namespace
  * Key
  * Value
  * Type-specific values (Integer, Boolean, JSON)

## Save & Discard Functionality

* Implemented dirty-state tracking.
* Added Save button state handling.
* Added Discard functionality to restore original data.
* Added "No changes to save" message when no updates exist.
* Added success and error status messages.

## GraphQL Enhancements

* Added Product loader query.
* Added Metafield loader query.
* Added Variant bulk update mutation.
* Added Metafield upsert mutation.
* Added Metafield delete mutation.
* Added error handling for GraphQL operations.

## UI Improvements

* Added reusable `LabelButton` component.
* Added reusable `TabButton` component.
* Added inline validation error display using `Err` component.
* Improved variant and metafield table layouts.
* Added visual indicators for:

  * Dirty metafields
  * Pending deletions
  * Loading state
  * Save state

## Additional Enhancements

* Added unsupported tab handling.
* Added no-op save detection.
* Added product image selection for variants.
* Added metafield add/remove workflows.

# Testing

* Verified variant updates.
* Verified metafield create/update/delete operations.
* Verified validation scenarios.
* Verified save/discard behavior.
* Verified dirty-state detection.
* Verified success and error messaging.

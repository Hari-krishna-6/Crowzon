export function getSellerStudioListings(listings, products, userId, assignedAccount, deployment) {
  if (!userId) return []

  const ownProducts = new Map(
    products
      .filter((product) =>
        Number(product.sellerId) === Number(userId) &&
        Number(product.chainId) === Number(deployment.chainId) &&
        product.marketplaceAddress?.toLowerCase() === deployment.marketplaceAddress.toLowerCase() &&
        product.deploymentId === deployment.deploymentId &&
        product.listingId !== null &&
        product.listingId !== undefined,
      )
      .map((product) => [String(product.listingId), product]),
  )

  return listings.flatMap((listing) => {
    const metadataProduct = ownProducts.get(String(listing.id))
    if (!metadataProduct) return []
    return [{
      ...listing,
      metadataProduct,
      chainManageable: Boolean(
        assignedAccount &&
        listing.seller.toLowerCase() === assignedAccount.toLowerCase(),
      ),
    }]
  })
}

export function ownsListingMetadata(products, listingId, userId, deployment) {
  return products.some((product) =>
    Number(product.sellerId) === Number(userId) &&
    Number(product.chainId) === Number(deployment.chainId) &&
    product.marketplaceAddress?.toLowerCase() === deployment.marketplaceAddress.toLowerCase() &&
    product.deploymentId === deployment.deploymentId &&
    String(product.listingId) === String(listingId),
  )
}

export class AuthenticationRequiredError extends Error {
  constructor() {
    super('A valid Crowzon session is required for this action.')
    this.name = 'AuthenticationRequiredError'
  }
}

export async function withAuthenticatedSession(getCurrentUser, action) {
  let user
  try {
    user = await getCurrentUser()
  } catch (error) {
    if (error?.status === 401) throw new AuthenticationRequiredError()
    throw error
  }

  if (!user || !Number.isInteger(Number(user.id))) {
    throw new AuthenticationRequiredError()
  }

  return action(user)
}

export function getAssignedBlockchainAccount(user, availableAccounts) {
  const assignedAccount = user?.assignedAccount
  if (typeof assignedAccount !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(assignedAccount)) {
    throw new Error('The authenticated profile has no valid assigned blockchain account.')
  }
  const availableAccount = availableAccounts.find(
    (account) => account.toLowerCase() === assignedAccount.toLowerCase(),
  )
  if (!availableAccount) {
    throw new Error('Your assigned blockchain account is not available on the local Hardhat node. No other account will be selected.')
  }
  return availableAccount
}

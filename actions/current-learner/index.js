const { almClient, almErrorResponse } = require('../shared/alm')

async function main () {
  const headers = {
    'Cache-Control': 'private, no-store',
    'Content-Type': 'application/json; charset=utf-8'
  }
  try {
    const user = await almClient().getUser()
    const accountRef = user.data.relationships?.account?.data
    const account = (user.included || []).find(item =>
      item.type === 'account' && item.id === accountRef?.id)
    return {
      statusCode: 200,
      headers,
      body: {
        dataScope: 'configured-alm-learner',
        learner: {
          id: user.data.id,
          name: typeof user.data.attributes?.name === 'string' ? user.data.attributes.name : null,
          roles: user.data.attributes.roles,
          account: accountRef?.id
            ? {
                id: accountRef.id,
                name: typeof account?.attributes?.name === 'string' ? account.attributes.name : null
              }
            : null
        }
      }
    }
  } catch (error) {
    const result = almErrorResponse(error)
    console.error(`[current-learner] ${result.body.code}`)
    return { ...result, headers }
  }
}

module.exports = { main }

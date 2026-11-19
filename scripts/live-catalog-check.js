require('dotenv').config()
const { almClient, almErrorResponse } = require('../actions/shared/alm')

function courseSummary (item) {
  const attributes = item.attributes || {}
  const localized = Array.isArray(attributes.localizedMetadata) ? attributes.localizedMetadata : []
  const metadata = localized.find(entry => entry.locale?.startsWith('en')) || localized[0]
  const description = metadata?.description
  return {
    id: item.id,
    title: metadata?.name || null,
    locale: metadata?.locale || null,
    descriptionCharacters: typeof description === 'string' ? description.replace(/<[^>]*>/g, '').trim().length : 0,
    type: attributes.loType || null,
    state: attributes.state || null,
    durationSeconds: Number.isFinite(attributes.duration) ? attributes.duration : null,
    tagCount: Array.isArray(attributes.tags) ? attributes.tags.length : null,
    hasProductsMetadata: Object.hasOwn(attributes, 'products'),
    skillReferences: Array.isArray(item.relationships?.skills?.data) ? item.relationships.skills.data.length : null
  }
}

function summarizeCourses (response) {
  const summaries = response.data.map(courseSummary)
  return {
    ...response.meta,
    coursesFetched: summaries.length,
    withTitle: summaries.filter(item => item.title).length,
    withDescription: summaries.filter(item => item.descriptionCharacters > 0).length,
    includedResourceTypes: [...new Set(response.included.map(item => item.type))],
    samples: summaries.slice(0, 3)
  }
}

async function run () {
  const statuses = {}
  const alm = almClient({
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname
      const operation = path.endsWith('/user') ? 'identity'
        : path.endsWith('/catalogs') ? 'catalogs'
          : path.endsWith('/learningObjects') ? 'courseLists' : 'courseDetails'
      const response = await fetch(url, options)
      const key = `${operation}:HTTP${response.status}`
      statuses[key] = (statuses[key] || 0) + 1
      return response
    }
  })
  await alm.getUser()
  const catalogs = await alm.getCatalogs()
  const courses = await alm.getCatalogLearningObjects()
  const report = {
    scope: 'configured-token-access; not proof of enrollment eligibility',
    catalogs: {
      ...catalogs.meta,
      count: catalogs.data.length,
      items: catalogs.data.map(item => ({
        id: item.id,
        name: typeof item.attributes?.name === 'string' ? item.attributes.name : null
      }))
    },
    courseSample: summarizeCourses(courses),
    checkedCatalogs: [],
    detailSample: null,
    describedCourseDetail: null
  }
  let describedCourseId = courses.data.find(item => courseSummary(item).descriptionCharacters > 0)?.id
  const configuredCatalog = process.env.ALM_PUBLIC_CATALOG_ID
  const catalogIds = configuredCatalog ? [configuredCatalog] : catalogs.data.slice(0, 10).map(item => item.id)
  report.catalogScopeCheck = {
    configuredCatalogOnly: Boolean(configuredCatalog),
    plannedCount: catalogIds.length,
    catalogsNotSelected: catalogs.data.filter(item => !catalogIds.includes(item.id)).length
  }
  for (const catalogId of catalogIds) {
    try {
      const response = await alm.getCatalogLearningObjects({ catalogId, maxPages: 2 })
      report.checkedCatalogs.push({ id: catalogId, ok: true, ...summarizeCourses(response) })
      describedCourseId ||= response.data.find(item => courseSummary(item).descriptionCharacters > 0)?.id
    } catch (error) {
      const failure = almErrorResponse(error)
      report.checkedCatalogs.push({ id: catalogId, ok: false, ...failure })
      process.exitCode = 1
      if ([401, 429].includes(failure.statusCode)) break
    }
  }
  if (!process.exitCode && courses.data.length) {
    const detail = await alm.getLearningObject(courses.data[0].id)
    report.detailSample = courseSummary(detail.data)
  }
  if (!process.exitCode && describedCourseId && describedCourseId !== report.detailSample?.id) {
    const detail = await alm.getLearningObject(describedCourseId)
    report.describedCourseDetail = courseSummary(detail.data)
  }
  report.httpStatuses = statuses
  console.log(JSON.stringify(report, null, 2))
}

if (require.main === module) {
  run().catch(error => {
    console.error(JSON.stringify(almErrorResponse(error)))
    process.exitCode = 1
  })
}

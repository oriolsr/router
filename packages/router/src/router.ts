import {
  RouteRecordRaw,
  Lazy,
  isRouteLocation,
  isRouteName,
  RouteLocationOptions,
  MatcherLocationRaw,
} from './types'
import type {
  RouteLocation,
  RouteLocationRaw,
  RouteParams,
  RouteLocationNormalized,
  RouteLocationNormalizedLoaded,
  NavigationGuardWithThis,
  NavigationHookAfter,
  RouteLocationResolved,
  RouteRecordNameGeneric,
} from './typed-routes'
import { HistoryState, NavigationType } from './history/common'
import {
  getSavedScrollPosition,
  getScrollKey,
  saveScrollPosition,
  computeScrollPosition,
  scrollToPosition,
  _ScrollPositionNormalized,
} from './scrollBehavior'
import { createRouterMatcher } from './matcher'
import {
  createRouterError,
  ErrorTypes,
  NavigationFailure,
  NavigationRedirectError,
  isNavigationFailure,
  _ErrorListener,
} from './errors'
import { applyToParams, isBrowser, assign, noop, isArray } from './utils'
import { useCallbacks } from './utils/callbacks'
import { encodeParam, decode, encodeHash } from './encoding'
import {
  normalizeQuery,
  parseQuery as originalParseQuery,
  stringifyQuery as originalStringifyQuery,
  LocationQuery,
} from './query'
import {
  shallowRef,
  nextTick,
  App,
  unref,
  shallowReactive,
  computed,
} from 'vue'
import { RouteRecordNormalized } from './matcher/types'
import {
  parseURL,
  stringifyURL,
  isSameRouteLocation,
  START_LOCATION_NORMALIZED,
} from './location'
import {
  extractChangingRecords,
  extractComponentsGuards,
  guardToPromiseFn,
  guardToPromiseFnWithLayers,
  loadRouteLocation,
} from './navigationGuards'
import { warn } from './warning'
import { RouterLink } from './RouterLink'
import { RouterView } from './RouterView'
import {
  routeLocationKey,
  routerKey,
  routerViewLocationKey,
  routerLayerKey,
  routerRoutesKey,
} from './injectionSymbols'
import { addDevtools } from './devtools'
import { _LiteralUnion } from './types/utils'
import {
  EXPERIMENTAL_RouterOptions_Base,
  EXPERIMENTAL_Router_Base,
  _OnReadyCallback,
} from './experimental/router'

/**
 * Options to initialize a {@link Router} instance.
 */
export interface RouterOptions extends EXPERIMENTAL_RouterOptions_Base {
  /**
   * Initial list of routes that should be added to the router.
   */
  routes: Readonly<RouteRecordRaw[]>
}

/**
 * Router instance.
 */
export interface Router
  extends EXPERIMENTAL_Router_Base<RouteRecordNormalized> {
  /**
   * Original options object passed to create the Router
   */
  readonly options: RouterOptions

  /**
   * Add a new {@link RouteRecordRaw | route record} as the child of an existing route.
   *
   * @param parentName - Parent Route Record where `route` should be appended at
   * @param route - Route Record to add
   */
  addRoute(
    // NOTE: it could be `keyof RouteMap` but the point of dynamic routes is not knowing the routes at build
    parentName: NonNullable<RouteRecordNameGeneric>,
    route: RouteRecordRaw
  ): () => void
  /**
   * Add a new {@link RouteRecordRaw | route record} to the router.
   *
   * @param route - Route Record to add
   */
  addRoute(route: RouteRecordRaw): () => void

  /**
   * Remove an existing route by its name.
   *
   * @param name - Name of the route to remove
   */
  removeRoute(name: NonNullable<RouteRecordNameGeneric>): void

  /**
   * Delete all routes from the router.
   */
  clearRoutes(): void

  /**
   * Add a new layer and navigate to it.
   */
  pushAddLayer(
    to: RouteLocationRaw
  ): Promise<NavigationFailure | void | undefined>

  /**
   * Add a new layer and replace current navigation.
   */
  replaceAddLayer(
    to: RouteLocationRaw
  ): Promise<NavigationFailure | void | undefined>

  /**
   * Remove the last layer.
   */
  pushRemoveLayer(): Promise<NavigationFailure | void | undefined>

  /**
   * Remove the last layer and replace current navigation.
   */
  replaceRemoveLayer(): Promise<NavigationFailure | void | undefined>

  /**
   * Navigate a specific layer.
   */
  pushLayer(
    layer: number,
    to: RouteLocationRaw
  ): Promise<NavigationFailure | void | undefined>

  /**
   * Navigate a specific layer and replace current navigation.
   */
  replaceLayer(
    layer: number,
    to: RouteLocationRaw
  ): Promise<NavigationFailure | void | undefined>

  /**
   * Navigate all layers at once.
   */
  pushAllLayers(
    locations: RouteLocationRaw[]
  ): Promise<NavigationFailure | void | undefined>

  /**
   * Navigate all layers at once and replace current navigation.
   */
  replaceAllLayers(
    locations: RouteLocationRaw[]
  ): Promise<NavigationFailure | void | undefined>

  /**
   * Current routes (layers) array. Used internally by RouterView to access routes for different layers.
   */
  readonly currentRoutes: RouteLocationNormalizedLoaded[]
}

/**
 * Creates a Router instance that can be used by a Vue app.
 *
 * @param options - {@link RouterOptions}
 */
export function createRouter(options: RouterOptions): Router {
  const matcher = createRouterMatcher(options.routes, options)
  const parseQuery = options.parseQuery || originalParseQuery
  const stringifyQuery = options.stringifyQuery || originalStringifyQuery
  const routerHistory = options.history
  if (__DEV__ && !routerHistory)
    throw new Error(
      'Provide the "history" option when calling "createRouter()":' +
        ' https://router.vuejs.org/api/interfaces/RouterOptions.html#history'
    )

  const beforeGuards = useCallbacks<NavigationGuardWithThis<undefined>>()
  const beforeResolveGuards = useCallbacks<NavigationGuardWithThis<undefined>>()
  const afterGuards = useCallbacks<NavigationHookAfter>()
  // Support multiple layers: store routes as an array
  const currentRoutes = shallowRef<RouteLocationNormalizedLoaded[]>([
    START_LOCATION_NORMALIZED,
  ])
  // Keep currentRoute for backward compatibility (returns last layer)
  const currentRoute = computed(() => {
    const route = currentRoutes.value[currentRoutes.value.length - 1]
    return route
  })
  let pendingLocations: RouteLocation[] = [START_LOCATION_NORMALIZED]

  // leave the scrollRestoration if no scrollBehavior is provided
  if (isBrowser && options.scrollBehavior && 'scrollRestoration' in history) {
    history.scrollRestoration = 'manual'
  }

  const normalizeParams = applyToParams.bind(
    null,
    paramValue => '' + paramValue
  )
  const encodeParams = applyToParams.bind(null, encodeParam)
  const decodeParams: (params: RouteParams | undefined) => RouteParams =
    // @ts-expect-error: intentionally avoid the type check
    applyToParams.bind(null, decode)

  function addRoute(
    parentOrRoute: NonNullable<RouteRecordNameGeneric> | RouteRecordRaw,
    route?: RouteRecordRaw
  ) {
    let parent: Parameters<(typeof matcher)['addRoute']>[1] | undefined
    let record: RouteRecordRaw
    if (isRouteName(parentOrRoute)) {
      parent = matcher.getRecordMatcher(parentOrRoute)
      if (__DEV__ && !parent) {
        warn(
          `Parent route "${String(
            parentOrRoute
          )}" not found when adding child route`,
          route
        )
      }
      record = route!
    } else {
      record = parentOrRoute
    }

    return matcher.addRoute(record, parent)
  }

  function removeRoute(name: NonNullable<RouteRecordNameGeneric>) {
    const recordMatcher = matcher.getRecordMatcher(name)
    if (recordMatcher) {
      matcher.removeRoute(recordMatcher)
    } else if (__DEV__) {
      warn(`Cannot remove non-existent route "${String(name)}"`)
    }
  }

  function getRoutes() {
    return matcher.getRoutes().map(routeMatcher => routeMatcher.record)
  }

  function hasRoute(name: NonNullable<RouteRecordNameGeneric>): boolean {
    return !!matcher.getRecordMatcher(name)
  }

  function resolve(
    rawLocation: RouteLocationRaw,
    currentLocation?: RouteLocationNormalizedLoaded
  ): RouteLocationResolved {
    // const resolve: Router['resolve'] = (rawLocation: RouteLocationRaw, currentLocation) => {
    // const objectLocation = routerLocationAsObject(rawLocation)
    // we create a copy to modify it later
    currentLocation = assign({}, currentLocation || currentRoute.value)
    if (typeof rawLocation === 'string') {
      const locationNormalized = parseURL(
        parseQuery,
        rawLocation,
        currentLocation.path
      )
      const matchedRoute = matcher.resolve(
        { path: locationNormalized.path },
        currentLocation
      )

      const href = routerHistory.createHref(locationNormalized.fullPath)
      if (__DEV__) {
        if (href.startsWith('//'))
          warn(
            `Location "${rawLocation}" resolved to "${href}". A resolved location cannot start with multiple slashes.`
          )
        else if (!matchedRoute.matched.length) {
          warn(`No match found for location with path "${rawLocation}"`)
        }
      }

      // locationNormalized is always a new object
      return assign(locationNormalized, matchedRoute, {
        params: decodeParams(matchedRoute.params),
        hash: decode(locationNormalized.hash),
        redirectedFrom: undefined,
        href,
      })
    }

    if (__DEV__ && !isRouteLocation(rawLocation)) {
      warn(
        `router.resolve() was passed an invalid location. This will fail in production.\n- Location:`,
        rawLocation
      )
      return resolve({})
    }

    let matcherLocation: MatcherLocationRaw

    // path could be relative in object as well
    if (rawLocation.path != null) {
      if (
        __DEV__ &&
        'params' in rawLocation &&
        !('name' in rawLocation) &&
        // @ts-expect-error: the type is never
        Object.keys(rawLocation.params).length
      ) {
        warn(
          `Path "${rawLocation.path}" was passed with params but they will be ignored. Use a named route alongside params instead.`
        )
      }
      matcherLocation = assign({}, rawLocation, {
        path: parseURL(parseQuery, rawLocation.path, currentLocation.path).path,
      })
    } else {
      // remove any nullish param
      const targetParams = assign({}, rawLocation.params)
      for (const key in targetParams) {
        if (targetParams[key] == null) {
          delete targetParams[key]
        }
      }
      // pass encoded values to the matcher, so it can produce encoded path and fullPath
      matcherLocation = assign({}, rawLocation, {
        params: encodeParams(targetParams),
      })
      // current location params are decoded, we need to encode them in case the
      // matcher merges the params
      currentLocation.params = encodeParams(currentLocation.params)
    }

    const matchedRoute = matcher.resolve(matcherLocation, currentLocation)
    const hash = rawLocation.hash || ''

    if (__DEV__ && hash && !hash.startsWith('#')) {
      warn(
        `A \`hash\` should always start with the character "#". Replace "${hash}" with "#${hash}".`
      )
    }

    // the matcher might have merged current location params, so
    // we need to run the decoding again
    matchedRoute.params = normalizeParams(decodeParams(matchedRoute.params))

    const fullPath = stringifyURL(
      stringifyQuery,
      assign({}, rawLocation, {
        hash: encodeHash(hash),
        path: matchedRoute.path,
      })
    )

    const href = routerHistory.createHref(fullPath)
    if (__DEV__) {
      if (href.startsWith('//')) {
        warn(
          `Location "${rawLocation}" resolved to "${href}". A resolved location cannot start with multiple slashes.`
        )
      } else if (!matchedRoute.matched.length) {
        warn(
          `No match found for location with path "${
            rawLocation.path != null ? rawLocation.path : rawLocation
          }"`
        )
      }
    }

    return assign(
      {
        fullPath,
        // keep the hash encoded so fullPath is effectively path + encodedQuery +
        // hash
        hash,
        query:
          // if the user is using a custom query lib like qs, we might have
          // nested objects, so we keep the query as is, meaning it can contain
          // numbers at `$route.query`, but at the point, the user will have to
          // use their own type anyway.
          // https://github.com/vuejs/router/issues/328#issuecomment-649481567
          stringifyQuery === originalStringifyQuery
            ? normalizeQuery(rawLocation.query)
            : ((rawLocation.query || {}) as LocationQuery),
      },
      matchedRoute,
      {
        redirectedFrom: undefined,
        href,
      }
    )
  }

  function locationAsObject(
    to: RouteLocationRaw | RouteLocationNormalized
  ): Exclude<RouteLocationRaw, string> | RouteLocationNormalized {
    return typeof to === 'string'
      ? parseURL(parseQuery, to, currentRoute.value.path)
      : assign({}, to)
  }

  function checkCanceledNavigation(
    to: RouteLocationNormalized,
    from: RouteLocationNormalized
  ): NavigationFailure | void {
    // Check if navigation was canceled by comparing with pending locations
    const lastPending = pendingLocations[pendingLocations.length - 1]
    if (lastPending !== to) {
      if (__DEV__)
        console.warn(
          '[Router] Navigation cancelled - pending location mismatch',
          { lastPending: lastPending?.fullPath, to: to.fullPath }
        )
      return createRouterError<NavigationFailure>(
        ErrorTypes.NAVIGATION_CANCELLED,
        {
          from,
          to,
        }
      )
    }
  }

  function push(to: RouteLocationRaw) {
    return pushWithRedirect(to)
  }

  function replace(to: RouteLocationRaw) {
    return push(assign(locationAsObject(to), { replace: true }))
  }

  // Layer navigation methods
  function pushAddLayer(to: RouteLocationRaw) {
    const newLocations = [
      ...currentRoutes.value.map(r => r.fullPath),
      resolve(to).fullPath,
    ]
    return navigateAllLayers(newLocations, true)
  }

  function replaceAddLayer(to: RouteLocationRaw) {
    const newLocations = [
      ...currentRoutes.value.map(r => r.fullPath),
      resolve(to).fullPath,
    ]
    return navigateAllLayers(newLocations, false)
  }

  function pushRemoveLayer() {
    if (currentRoutes.value.length <= 1) {
      return Promise.resolve()
    }
    const newLocations = currentRoutes.value.slice(0, -1).map(r => r.fullPath)
    return navigateAllLayers(newLocations, true)
  }

  function replaceRemoveLayer() {
    if (currentRoutes.value.length <= 1) {
      return Promise.resolve()
    }
    const newLocations = currentRoutes.value.slice(0, -1).map(r => r.fullPath)
    return navigateAllLayers(newLocations, false)
  }

  function pushLayer(layer: number, to: RouteLocationRaw) {
    const newLocations = [
      ...currentRoutes.value.slice(0, layer).map(r => r.fullPath),
      resolve(to).fullPath,
      ...currentRoutes.value.slice(layer + 1).map(r => r.fullPath),
    ]
    return navigateAllLayers(newLocations, true)
  }

  function replaceLayer(layer: number, to: RouteLocationRaw) {
    const newLocations = [
      ...currentRoutes.value.slice(0, layer).map(r => r.fullPath),
      resolve(to).fullPath,
      ...currentRoutes.value.slice(layer + 1).map(r => r.fullPath),
    ]
    return navigateAllLayers(newLocations, false)
  }

  function pushAllLayers(locations: RouteLocationRaw[]) {
    const newLocations = locations.map(loc => resolve(loc).fullPath)
    return navigateAllLayers(newLocations, true)
  }

  function replaceAllLayers(locations: RouteLocationRaw[]) {
    const newLocations = locations.map(loc => resolve(loc).fullPath)
    return navigateAllLayers(newLocations, false)
  }

  function navigateAllLayers(
    locations: string[],
    push: boolean
  ): Promise<NavigationFailure | void | undefined> {
    if (locations.length === 0) {
      return Promise.resolve()
    }

    // IMPORTANT: Limit to max 2 layers (router supports max 2 layers)
    // Take only the last 2 locations if more are provided
    const limitedLocations = locations.slice(-2)

    // Resolve all locations
    const resolvedLocations = limitedLocations.map((loc, index) => {
      const current =
        index < currentRoutes.value.length
          ? currentRoutes.value[index]
          : currentRoute.value
      return resolve(loc, current) as RouteLocationNormalized
    })

    // IMPORTANT: Ensure we don't have duplicate routes in the layers
    // If we have 2 layers and they resolve to the same route, keep only one
    if (resolvedLocations.length === 2) {
      const [first, second] = resolvedLocations
      // If both routes have the same fullPath, they're duplicates
      // In this case, keep only the second (modal) route as a single layer
      if (first.fullPath === second.fullPath) {
        resolvedLocations.splice(0, 1)
      }
    }

    // Navigate to the last layer (which will update the URL)
    const lastLocation = resolvedLocations[resolvedLocations.length - 1]
    // IMPORTANT: Ensure pendingLocations doesn't exceed 2 layers
    pendingLocations = resolvedLocations

    // Create a location object with replace flag if needed
    const locationOptions: RouteLocationOptions = push ? {} : { replace: true }

    // pushWithRedirect will trigger the navigation flow which calls finalizeNavigation
    // finalizeNavigation is responsible for updating currentRoutes.value
    // We don't need to update it here - doing so would cause duplicate updates and
    // the comparison would be against the already-updated route, making it always "same"
    return pushWithRedirect(
      assign(locationAsObject(lastLocation), locationOptions)
    )
  }

  function handleRedirectRecord(
    to: RouteLocation,
    from: RouteLocationNormalizedLoaded
  ): RouteLocationRaw | void {
    const lastMatched = to.matched[to.matched.length - 1]
    if (lastMatched && lastMatched.redirect) {
      const { redirect } = lastMatched
      let newTargetLocation =
        typeof redirect === 'function' ? redirect(to, from) : redirect

      if (typeof newTargetLocation === 'string') {
        newTargetLocation =
          newTargetLocation.includes('?') || newTargetLocation.includes('#')
            ? (newTargetLocation = locationAsObject(newTargetLocation))
            : // force empty params
              { path: newTargetLocation }
        // @ts-expect-error: force empty params when a string is passed to let
        // the router parse them again
        newTargetLocation.params = {}
      }

      if (
        __DEV__ &&
        newTargetLocation.path == null &&
        !('name' in newTargetLocation)
      ) {
        warn(
          `Invalid redirect found:\n${JSON.stringify(
            newTargetLocation,
            null,
            2
          )}\n when navigating to "${
            to.fullPath
          }". A redirect must contain a name or path. This will break in production.`
        )
        throw new Error('Invalid redirect')
      }

      return assign(
        {
          query: to.query,
          hash: to.hash,
          // avoid transferring params if the redirect has a path
          params: newTargetLocation.path != null ? {} : to.params,
        },
        newTargetLocation
      )
    }
  }

  function pushWithRedirect(
    to: RouteLocationRaw | RouteLocation,
    redirectedFrom?: RouteLocation
  ): Promise<NavigationFailure | void | undefined> {
    const targetLocation: RouteLocation = resolve(to)
    // Preserve pendingLocations if it already has multiple entries AND:
    // 1. We're in a redirect (preserve multi-layer structure through redirects)
    // 2. The last entry's fullPath matches targetLocation (navigateAllLayers just set it)
    // Otherwise, reset to single location for regular navigations
    const hadMultipleLayers = pendingLocations.length > 1
    const isRedirect = redirectedFrom !== undefined
    const lastPending = hadMultipleLayers
      ? pendingLocations[pendingLocations.length - 1]
      : null
    const lastPendingMatchesTarget =
      lastPending && lastPending.fullPath === targetLocation.fullPath

    if (hadMultipleLayers && (isRedirect || lastPendingMatchesTarget)) {
      if (isRedirect) {
        // Update the last entry to the new target (in case of redirects)
        // This preserves the multi-layer structure through redirects
        pendingLocations[pendingLocations.length - 1] = targetLocation
      } else if (lastPendingMatchesTarget) {
        // navigateAllLayers just set pendingLocations correctly
        // Update the last entry to use the resolved targetLocation to ensure object reference matches
        // This prevents "pending location mismatch" errors in checkCanceledNavigation
        pendingLocations[pendingLocations.length - 1] = targetLocation
      }
    } else {
      // Reset to single location for regular navigations
      // This ensures single-route navigations don't accidentally use multiple layers
      pendingLocations = [targetLocation]
    }
    const from = currentRoute.value
    const data: HistoryState | undefined = (to as RouteLocationOptions).state
    const force: boolean | undefined = (to as RouteLocationOptions).force
    // to could be a string where `replace` is a function
    const replace = (to as RouteLocationOptions).replace === true

    const shouldRedirect = handleRedirectRecord(targetLocation, from)

    if (shouldRedirect) {
      // When redirecting, pushWithRedirect will be called recursively
      // Since we've already updated pendingLocations above (preserving multi-layer if it existed),
      // the recursive call will also preserve it because hadMultipleLayers will still be true
      return pushWithRedirect(
        assign(locationAsObject(shouldRedirect), {
          state:
            typeof shouldRedirect === 'object'
              ? assign({}, data, shouldRedirect.state)
              : data,
          force,
          replace,
        }),
        // keep original redirectedFrom if it exists
        redirectedFrom || targetLocation
      )
    }

    // if it was a redirect we already called `pushWithRedirect` above
    const toLocation = targetLocation as RouteLocationNormalized

    toLocation.redirectedFrom = redirectedFrom
    let failure: NavigationFailure | void | undefined

    if (!force && isSameRouteLocation(stringifyQuery, from, targetLocation)) {
      failure = createRouterError<NavigationFailure>(
        ErrorTypes.NAVIGATION_DUPLICATED,
        { to: toLocation, from }
      )
      // trigger scroll to allow scrolling to the same anchor
      handleScroll(
        from,
        from,
        // this is a push, the only way for it to be triggered from a
        // history.listen is with a redirect, which makes it become a push
        true,
        // This cannot be the first navigation because the initial location
        // cannot be manually navigated to
        false
      )
    }

    return (failure ? Promise.resolve(failure) : navigate(toLocation, from))
      .catch((error: NavigationFailure | NavigationRedirectError) =>
        isNavigationFailure(error)
          ? // navigation redirects still mark the router as ready
            isNavigationFailure(error, ErrorTypes.NAVIGATION_GUARD_REDIRECT)
            ? error
            : markAsReady(error) // also returns the error
          : // reject any unknown error
            triggerError(error, toLocation, from)
      )
      .then((failure: NavigationFailure | NavigationRedirectError | void) => {
        if (failure) {
          if (
            isNavigationFailure(failure, ErrorTypes.NAVIGATION_GUARD_REDIRECT)
          ) {
            if (
              __DEV__ &&
              // we are redirecting to the same location we were already at
              isSameRouteLocation(
                stringifyQuery,
                resolve(failure.to),
                toLocation
              ) &&
              // and we have done it a couple of times
              redirectedFrom &&
              // @ts-expect-error: added only in dev
              (redirectedFrom._count = redirectedFrom._count
                ? // @ts-expect-error
                  redirectedFrom._count + 1
                : 1) > 30
            ) {
              warn(
                `Detected a possibly infinite redirection in a navigation guard when going from "${from.fullPath}" to "${toLocation.fullPath}". Aborting to avoid a Stack Overflow.\n Are you always returning a new location within a navigation guard? That would lead to this error. Only return when redirecting or aborting, that should fix this. This might break in production if not fixed.`
              )
              return Promise.reject(
                new Error('Infinite redirect in navigation guard')
              )
            }

            return pushWithRedirect(
              // keep options
              assign(
                {
                  // preserve an existing replacement but allow the redirect to override it
                  replace,
                },
                locationAsObject(failure.to),
                {
                  state:
                    typeof failure.to === 'object'
                      ? assign({}, data, failure.to.state)
                      : data,
                  force,
                }
              ),
              // preserve the original redirectedFrom if any
              redirectedFrom || toLocation
            )
          }
        } else {
          // if we fail we don't finalize the navigation
          // Construct all layers: use pendingLocations (which now have resolved components)
          // pendingLocations was updated in the previous step to have all components resolved
          const toLocations: RouteLocationNormalizedLoaded[] =
            pendingLocations.length > 1
              ? pendingLocations.map((loc, index) => {
                  // For the last layer, use toLocation (has resolved components from navigation)
                  if (index === pendingLocations.length - 1) {
                    return toLocation as RouteLocationNormalizedLoaded
                  }
                  // For other layers, use the loaded location from pendingLocations (components already resolved)
                  return loc as RouteLocationNormalizedLoaded
                })
              : [toLocation as RouteLocationNormalizedLoaded]

          const fromLocations: RouteLocationNormalizedLoaded[] =
            currentRoutes.value.length > 1 ? currentRoutes.value : [from]

          failure = finalizeNavigation(
            toLocations,
            fromLocations,
            true,
            replace,
            data
          )
        }
        triggerAfterEach(
          toLocation as RouteLocationNormalizedLoaded,
          from,
          failure
        )
        return failure
      })
  }

  /**
   * Helper to reject and skip all navigation guards if a new navigation happened
   * @param to
   * @param from
   */
  function checkCanceledNavigationAndReject(
    to: RouteLocationNormalized,
    from: RouteLocationNormalized
  ): Promise<void> {
    const error = checkCanceledNavigation(to, from)
    return error ? Promise.reject(error) : Promise.resolve()
  }

  function runWithContext<T>(fn: () => T): T {
    const app: App | undefined = installedApps.values().next().value
    // support Vue < 3.3
    // Note: app.runWithContext() provides app context but inject() requires component setup context
    // If guards use inject(), they will trigger a warning but navigation will still work
    return app && typeof app.runWithContext === 'function'
      ? app.runWithContext(fn)
      : fn()
  }

  // TODO: refactor the whole before guards by internally using router.beforeEach

  function navigate(
    to: RouteLocationNormalized,
    from: RouteLocationNormalizedLoaded
  ): Promise<any> {
    let guards: Lazy<any>[]

    const [leavingRecords, updatingRecords, enteringRecords] =
      extractChangingRecords(to, from)

    // all components here have been resolved once because we are leaving
    guards = extractComponentsGuards(
      leavingRecords.reverse(),
      'beforeRouteLeave',
      to,
      from
    )

    // leavingRecords is already reversed
    for (const record of leavingRecords) {
      record.leaveGuards.forEach(guard => {
        guards.push(guardToPromiseFn(guard, to, from))
      })
    }

    const canceledNavigationCheck = checkCanceledNavigationAndReject.bind(
      null,
      to,
      from
    )

    guards.push(canceledNavigationCheck)

    // run the queue of per route beforeRouteLeave guards
    return (
      runGuardQueue(guards)
        .then(() => {
          // check global guards beforeEach
          // Pass arrays of routes (layers) to match router-legacy behavior
          guards = []
          // Build toRoutes array: use pendingLocations if it has multiple entries (multi-layer navigation),
          // otherwise construct array with single 'to' route
          // IMPORTANT: Limit to max 2 layers (router supports max 2 layers)
          let toRoutes: RouteLocationNormalized[] =
            pendingLocations.length > 1
              ? pendingLocations.slice(-2).map(loc => {
                  // pendingLocations may contain RouteLocation or RouteLocationNormalized
                  // Ensure all are normalized
                  if ('matched' in loc && loc.matched) {
                    // Already normalized
                    return loc as RouteLocationNormalized
                  }
                  // Need to normalize
                  return resolve(
                    loc.fullPath || loc.path || ''
                  ) as RouteLocationNormalized
                })
              : [to]

          // IMPORTANT: Remove duplicates from toRoutes
          // If we have 2 routes with the same fullPath, keep only one (the last one)
          if (toRoutes.length === 2) {
            const [first, second] = toRoutes
            if (first.fullPath === second.fullPath) {
              toRoutes = [second] // Keep only the last (modal) route
            }
          }
          // Use currentRoutes for 'from' (array of current routes/layers)
          // IMPORTANT: Limit to max 2 layers (router supports max 2 layers)
          const fromRoutes = currentRoutes.value.slice(-2)

          const beforeGuardsList = beforeGuards.list()
          for (const guard of beforeGuardsList) {
            guards.push(
              guardToPromiseFnWithLayers(
                guard,
                toRoutes,
                fromRoutes,
                runWithContext
              )
            )
          }
          guards.push(canceledNavigationCheck)

          return runGuardQueue(guards)
        })
        .then(() => {
          // check in components beforeRouteUpdate
          guards = extractComponentsGuards(
            updatingRecords,
            'beforeRouteUpdate',
            to,
            from
          )

          for (const record of updatingRecords) {
            record.updateGuards.forEach(guard => {
              guards.push(guardToPromiseFn(guard, to, from))
            })
          }
          guards.push(canceledNavigationCheck)

          // run the queue of per route beforeEnter guards
          return runGuardQueue(guards)
        })
        .then(() => {
          // check the route beforeEnter
          guards = []
          for (const record of enteringRecords) {
            // do not trigger beforeEnter on reused views
            if (record.beforeEnter) {
              if (isArray(record.beforeEnter)) {
                for (const beforeEnter of record.beforeEnter)
                  guards.push(guardToPromiseFn(beforeEnter, to, from))
              } else {
                guards.push(guardToPromiseFn(record.beforeEnter, to, from))
              }
            }
          }
          guards.push(canceledNavigationCheck)

          // run the queue of per route beforeEnter guards
          return runGuardQueue(guards)
        })
        .then(() => {
          // NOTE: at this point to.matched is normalized and does not contain any () => Promise<Component>
          // But for multi-layer navigation, we need to ensure ALL layers have resolved components
          // Load all pending locations to ensure their components are resolved
          if (pendingLocations.length > 1) {
            // Load all layers' components before proceeding
            const loadPromises = pendingLocations.map(loc => {
              // If it's already a RouteLocationNormalized with resolved components, use it
              if ('matched' in loc && loc.matched && loc.matched.length > 0) {
                // Check if components are already resolved (not functions)
                const hasUnresolvedComponents = loc.matched.some(
                  record =>
                    record.components &&
                    Object.values(record.components).some(
                      comp =>
                        typeof comp === 'function' && !('displayName' in comp)
                    )
                )
                if (!hasUnresolvedComponents) {
                  return Promise.resolve(loc as RouteLocationNormalizedLoaded)
                }
              }
              // Otherwise, load the route location to resolve async components
              return loadRouteLocation(loc)
            })
            return Promise.all(loadPromises).then(loadedLocations => {
              // Update pendingLocations with loaded locations (components resolved)
              // Type assertion: loadedLocations are now RouteLocationNormalizedLoaded[]
              pendingLocations = loadedLocations as any
              // Continue with beforeRouteEnter guards
              // clear existing enterCallbacks, these are added by extractComponentsGuards
              to.matched.forEach(record => (record.enterCallbacks = {}))

              // check in-component beforeRouteEnter
              guards = extractComponentsGuards(
                enteringRecords,
                'beforeRouteEnter',
                to,
                from,
                runWithContext
              )
              guards.push(canceledNavigationCheck)

              // run the queue of per route beforeEnter guards
              return runGuardQueue(guards)
            })
          } else {
            // Single layer navigation - components already resolved
            // clear existing enterCallbacks, these are added by extractComponentsGuards
            to.matched.forEach(record => (record.enterCallbacks = {}))

            // check in-component beforeRouteEnter
            guards = extractComponentsGuards(
              enteringRecords,
              'beforeRouteEnter',
              to,
              from,
              runWithContext
            )
            guards.push(canceledNavigationCheck)

            // run the queue of per route beforeEnter guards
            return runGuardQueue(guards)
          }
        })
        .then(() => {
          // check global guards beforeResolve
          guards = []
          for (const guard of beforeResolveGuards.list()) {
            guards.push(guardToPromiseFn(guard, to, from))
          }
          guards.push(canceledNavigationCheck)

          return runGuardQueue(guards)
        })
        // catch any navigation canceled
        .catch(err =>
          isNavigationFailure(err, ErrorTypes.NAVIGATION_CANCELLED)
            ? err
            : Promise.reject(err)
        )
    )
  }

  function triggerAfterEach(
    to: RouteLocationNormalizedLoaded,
    from: RouteLocationNormalizedLoaded,
    failure?: NavigationFailure | void
  ): void {
    // navigation is confirmed, call afterGuards
    // TODO: wrap with error handlers
    afterGuards
      .list()
      .forEach(guard => runWithContext(() => guard(to, from, failure)))
  }

  /**
   * - Cleans up any navigation guards
   * - Changes the url if necessary
   * - Calls the scrollBehavior
   */
  function finalizeNavigation(
    toLocations: RouteLocationNormalizedLoaded[],
    fromLocations: RouteLocationNormalizedLoaded[],
    isPush: boolean,
    replace?: boolean,
    data?: HistoryState
  ): NavigationFailure | void {
    const toLocation = toLocations[toLocations.length - 1]
    const from = fromLocations[fromLocations.length - 1]

    // a more recent navigation took place
    const error = checkCanceledNavigation(toLocation, from)
    if (error) return error

    // only consider as push if it's not the first navigation
    const isFirstNavigation = from === START_LOCATION_NORMALIZED
    const state: Partial<HistoryState> | null = !isBrowser ? {} : history.state

    // change URL only if the user did a push/replace and if it's not the initial navigation because
    // it's just reflecting the url
    if (isPush) {
      // Prepare layers array from all locations (matching router-legacy: state.state)
      const layers = toLocations.map(loc => loc.fullPath)

      // on the initial navigation, we want to reuse the scroll position from
      // history state if it exists
      if (replace || isFirstNavigation)
        routerHistory.replace(
          toLocation.fullPath,
          assign(
            {
              scroll: isFirstNavigation && state && state.scroll,
              state: layers, // Match router-legacy structure
            },
            data
          )
        )
      else
        routerHistory.push(toLocation.fullPath, assign({ state: layers }, data))
    }

    // accept current navigation - update all layers
    // Use toLocations (which has resolved components) when available
    // If pendingLocations has multiple entries and toLocations matches, use toLocations
    // Otherwise construct from pendingLocations but ensure components are resolved
    // IMPORTANT: Limit to max 2 layers (router supports max 2 layers)
    // IMPORTANT: If toLocations has only one entry, we should only have one layer in currentRoutes
    // to prevent non-modal routes from being rendered in next-layer

    // Check if the route is the same as the current route to avoid unnecessary updates
    // This prevents currentRoute (computed from currentRoutes) from changing reference
    // when the route is logically the same, which would trigger watchers unnecessarily
    const currentLastRoute = currentRoutes.value[currentRoutes.value.length - 1]
    const isSameRoute =
      currentLastRoute &&
      isSameRouteLocation(stringifyQuery, currentLastRoute, toLocation)

    // If the route is the same and we're doing a single-layer navigation, don't update
    // This prevents currentRoute computed from returning a new reference unnecessarily
    if (
      isSameRoute &&
      toLocations.length === 1 &&
      currentRoutes.value.length === 1
    ) {
      // Route is the same, no need to update currentRoutes.value
      // This keeps currentRoute returning the same object reference
    } else {
      // Route changed or multi-layer navigation - update currentRoutes
      let newCurrentRoutes: RouteLocationNormalizedLoaded[]
      if (toLocations.length === 1) {
        // Single route navigation - always use single layer
        // Don't use pendingLocations even if it has multiple entries
        newCurrentRoutes = toLocations
      } else if (
        pendingLocations.length > 1 &&
        toLocations.length === pendingLocations.length
      ) {
        // Multiple layers navigation - use toLocations which has resolved components
        // Limit to max 2 layers (take last 2)
        newCurrentRoutes = toLocations.slice(-2)
      } else if (pendingLocations.length > 1 && toLocations.length > 1) {
        // Fallback: Convert pendingLocations to loaded locations
        // This should rarely happen, but ensures we have the right number of layers
        // Only do this if toLocations also has multiple entries
        // Limit to max 2 layers (take last 2)
        const loadedLocations = pendingLocations.slice(-2).map((loc, index) => {
          // Prefer toLocations[index] if available (has resolved components)
          // Adjust index to account for slice(-2)
          const toLocationsIndex = toLocations.length - 2 + index
          if (toLocationsIndex >= 0 && toLocationsIndex < toLocations.length) {
            return toLocations[toLocationsIndex]
          }
          // Otherwise resolve the location (components should be resolved by now)
          return resolve(loc.fullPath) as RouteLocationNormalizedLoaded
        })
        newCurrentRoutes = loadedLocations
      } else {
        // Single layer - limit to 1
        newCurrentRoutes = toLocations.slice(-1)
      }

      currentRoutes.value = newCurrentRoutes
    }
    handleScroll(toLocation, from, isPush, isFirstNavigation)

    markAsReady()
  }

  let removeHistoryListener: undefined | null | (() => void)
  // attach listener to history to trigger navigations
  function setupListeners() {
    // avoid setting up listeners twice due to an invalid first navigation
    if (removeHistoryListener) return
    removeHistoryListener = routerHistory.listen((to, _from, info) => {
      if (!router.listening) {
        if (__DEV__)
          console.warn(
            '[Router] History listener called but router.listening is false'
          )
        return
      }
      // cannot be a redirect route because it was in history
      const toLocation = resolve(to) as RouteLocationNormalized

      // due to dynamic routing, and to hash history with manual navigation
      // (manually changing the url or calling history.hash = '#/somewhere'),
      // there could be a redirect record in history
      const shouldRedirect = handleRedirectRecord(
        toLocation,
        router.currentRoute.value
      )
      if (shouldRedirect) {
        pushWithRedirect(
          assign(shouldRedirect, { replace: true, force: true }),
          toLocation
        ).catch(noop)
        return
      }

      // Handle layers from history state if available
      if (info.layers && info.layers.length > 0) {
        // Resolve all layer locations
        const resolvedLayers = info.layers.map((layerPath, index) => {
          const current =
            index < currentRoutes.value.length
              ? currentRoutes.value[index]
              : currentRoute.value
          return resolve(layerPath, current) as RouteLocationNormalized
        })
        // If there's only one layer and it matches toLocation, use toLocation directly
        // to avoid object reference mismatch in checkCanceledNavigation
        if (
          resolvedLayers.length === 1 &&
          resolvedLayers[0].fullPath === toLocation.fullPath
        ) {
          pendingLocations = [toLocation]
        } else {
          pendingLocations = resolvedLayers
        }
      } else {
        // Fallback to single location
        pendingLocations = [toLocation]
      }
      const from = currentRoute.value

      // TODO: should be moved to web history?
      if (isBrowser) {
        saveScrollPosition(
          getScrollKey(from.fullPath, info.delta),
          computeScrollPosition()
        )
      }

      navigate(toLocation, from)
        .then(failure => {
          // Navigation completed
        })
        .catch((error: NavigationFailure | NavigationRedirectError) => {
          if (
            isNavigationFailure(
              error,
              ErrorTypes.NAVIGATION_ABORTED | ErrorTypes.NAVIGATION_CANCELLED
            )
          ) {
            return error
          }
          if (
            isNavigationFailure(error, ErrorTypes.NAVIGATION_GUARD_REDIRECT)
          ) {
            // Here we could call if (info.delta) routerHistory.go(-info.delta,
            // false) but this is bug prone as we have no way to wait the
            // navigation to be finished before calling pushWithRedirect. Using
            // a setTimeout of 16ms seems to work but there is no guarantee for
            // it to work on every browser. So instead we do not restore the
            // history entry and trigger a new navigation as requested by the
            // navigation guard.

            // the error is already handled by router.push we just want to avoid
            // logging the error
            pushWithRedirect(
              assign(locationAsObject((error as NavigationRedirectError).to), {
                force: true,
              }),
              toLocation
              // avoid an uncaught rejection, let push call triggerError
            )
              .then(failure => {
                // manual change in hash history #916 ending up in the URL not
                // changing, but it was changed by the manual url change, so we
                // need to manually change it ourselves
                if (
                  isNavigationFailure(
                    failure,
                    ErrorTypes.NAVIGATION_ABORTED |
                      ErrorTypes.NAVIGATION_DUPLICATED
                  ) &&
                  !info.delta &&
                  info.type === NavigationType.pop
                ) {
                  routerHistory.go(-1, false)
                }
              })
              .catch(noop)
            // avoid the then branch
            return Promise.reject()
          }
          // do not restore history on unknown direction
          if (info.delta) {
            routerHistory.go(-info.delta, false)
          }
          // unrecognized error, transfer to the global handler
          return triggerError(error, toLocation, from)
        })
        .then((failure: unknown) => {
          const navFailure = failure as NavigationFailure | void
          const finalFailure =
            navFailure ||
            finalizeNavigation(
              // after navigation, all matched components are resolved
              [toLocation as RouteLocationNormalizedLoaded],
              [from],
              false
            )

          // revert the navigation
          if (finalFailure) {
            if (
              info.delta &&
              // a new navigation has been triggered, so we do not want to revert, that will change the current history
              // entry while a different route is displayed
              !isNavigationFailure(
                finalFailure,
                ErrorTypes.NAVIGATION_CANCELLED
              )
            ) {
              routerHistory.go(-info.delta, false)
            } else if (
              info.type === NavigationType.pop &&
              isNavigationFailure(
                finalFailure,
                ErrorTypes.NAVIGATION_ABORTED | ErrorTypes.NAVIGATION_DUPLICATED
              )
            ) {
              // manual change in hash history #916
              // it's like a push but lacks the information of the direction
              routerHistory.go(-1, false)
            }
          }

          triggerAfterEach(
            toLocation as RouteLocationNormalizedLoaded,
            from,
            finalFailure
          )
        })
        // avoid warnings in the console about uncaught rejections, they are logged by triggerErrors
        .catch(noop)
    })
  }

  // Initialization and Errors

  let readyHandlers = useCallbacks<_OnReadyCallback>()
  let errorListeners = useCallbacks<_ErrorListener>()
  let ready: boolean

  /**
   * Trigger errorListeners added via onError and throws the error as well
   *
   * @param error - error to throw
   * @param to - location we were navigating to when the error happened
   * @param from - location we were navigating from when the error happened
   * @returns the error as a rejected promise
   */
  function triggerError(
    error: any,
    to: RouteLocationNormalized,
    from: RouteLocationNormalizedLoaded
  ): Promise<unknown> {
    markAsReady(error)
    const list = errorListeners.list()
    if (list.length) {
      list.forEach(handler => handler(error, to, from))
    } else {
      if (__DEV__) {
        warn('uncaught error during route navigation:')
      }
      console.error(error)
    }
    // reject the error no matter there were error listeners or not
    return Promise.reject(error)
  }

  function isReady(): Promise<void> {
    if (ready && currentRoute.value !== START_LOCATION_NORMALIZED)
      return Promise.resolve()
    return new Promise((resolve, reject) => {
      readyHandlers.add([resolve, reject])
    })
  }

  /**
   * Mark the router as ready, resolving the promised returned by isReady(). Can
   * only be called once, otherwise does nothing.
   * @param err - optional error
   */
  function markAsReady<E = any>(err: E): E
  function markAsReady<E = any>(): void
  function markAsReady<E = any>(err?: E): E | void {
    if (!ready) {
      // still not ready if an error happened
      ready = !err
      setupListeners()
      readyHandlers
        .list()
        .forEach(([resolve, reject]) => (err ? reject(err) : resolve()))
      readyHandlers.reset()
    }
    return err
  }

  // Scroll behavior
  function handleScroll(
    to: RouteLocationNormalizedLoaded,
    from: RouteLocationNormalizedLoaded,
    isPush: boolean,
    isFirstNavigation: boolean
  ): // the return is not meant to be used
  Promise<unknown> {
    const { scrollBehavior } = options
    if (!isBrowser || !scrollBehavior) return Promise.resolve()

    const scrollPosition: _ScrollPositionNormalized | null =
      (!isPush && getSavedScrollPosition(getScrollKey(to.fullPath, 0))) ||
      ((isFirstNavigation || !isPush) &&
        (history.state as HistoryState) &&
        history.state.scroll) ||
      null

    return nextTick()
      .then(() => scrollBehavior(to, from, scrollPosition))
      .then(position => position && scrollToPosition(position))
      .catch(err => triggerError(err, to, from))
  }

  const go = (delta: number) => {
    // Call routerHistory.go() which triggers window.history.go()
    // This fires a popstate event that will be handled by the history listener
    // The listener will then call navigate() which triggers beforeEach guards
    //
    // Note: In router-legacy, go() also just called window.history.go() and relied
    // on popstate events. The popstate handler should trigger navigation automatically.
    // If it doesn't, there may be an issue with the history listener setup.
    routerHistory.go(delta)
  }

  let started: boolean | undefined
  const installedApps = new Set<App>()

  const router: Router = {
    currentRoute,
    // Expose currentRoutes for internal use (e.g., RouterView)
    get currentRoutes() {
      return currentRoutes.value
    },
    listening: true,

    addRoute,
    removeRoute,
    clearRoutes: matcher.clearRoutes,
    hasRoute,
    getRoutes,
    resolve,
    options,

    push,
    replace,
    go,
    back: () => go(-1),
    forward: () => go(1),

    pushAddLayer,
    replaceAddLayer,
    pushRemoveLayer,
    replaceRemoveLayer,
    pushLayer,
    replaceLayer,
    pushAllLayers,
    replaceAllLayers,

    beforeEach: beforeGuards.add,
    beforeResolve: beforeResolveGuards.add,
    afterEach: afterGuards.add,

    onError: errorListeners.add,
    isReady,

    install(app: App) {
      app.component('RouterLink', RouterLink)
      app.component('RouterView', RouterView)

      app.config.globalProperties.$router = router
      Object.defineProperty(app.config.globalProperties, '$route', {
        enumerable: true,
        get: () => unref(currentRoute),
      })

      // this initial navigation is only necessary on client, on server it doesn't
      // make sense because it will create an extra unnecessary navigation and could
      // lead to problems
      if (
        isBrowser &&
        // used for the initial navigation client side to avoid pushing
        // multiple times when the router is used in multiple apps
        !started &&
        currentRoute.value === START_LOCATION_NORMALIZED
      ) {
        // see above
        started = true
        push(routerHistory.location).catch(err => {
          if (__DEV__) warn('Unexpected error when starting the router:', err)
        })
      }

      const reactiveRoute = {} as RouteLocationNormalizedLoaded
      for (const key in START_LOCATION_NORMALIZED) {
        Object.defineProperty(reactiveRoute, key, {
          get: () => currentRoute.value[key as keyof RouteLocationNormalized],
          enumerable: true,
        })
      }

      app.provide(routerKey, router)
      app.provide(routeLocationKey, shallowReactive(reactiveRoute))
      app.provide(routerViewLocationKey, currentRoute)
      // Provide layer context (default to layer 0)
      app.provide(routerLayerKey, 0)
      // Provide routes array for multi-layer support (reactive)
      app.provide(routerRoutesKey, currentRoutes)

      const unmountApp = app.unmount
      installedApps.add(app)
      app.unmount = function () {
        installedApps.delete(app)
        // the router is not attached to an app anymore
        if (installedApps.size < 1) {
          // invalidate the current navigation
          pendingLocations = [START_LOCATION_NORMALIZED]
          removeHistoryListener && removeHistoryListener()
          removeHistoryListener = null
          currentRoutes.value = [START_LOCATION_NORMALIZED]
          started = false
          ready = false
        }
        unmountApp()
      }

      // TODO: this probably needs to be updated so it can be used by vue-termui
      if ((__DEV__ || __FEATURE_PROD_DEVTOOLS__) && isBrowser) {
        addDevtools(app, router, matcher)
      }
    },
  }

  // TODO: type this as NavigationGuardReturn or similar instead of any
  function runGuardQueue(guards: Lazy<any>[]): Promise<any> {
    return guards.reduce(
      (promise, guard) => promise.then(() => runWithContext(guard)),
      Promise.resolve()
    )
  }

  return router
}

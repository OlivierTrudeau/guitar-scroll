/*
 * analytics.js — usage tracking for GuitarScroll, powered by PostHog.
 *
 * WHY POSTHOG: unlike a simple pageview counter, PostHog can follow an
 * *anonymous* person across visits, so you get real "user stories" — retention
 * cohorts (who's still around after a week/month), individual timelines, and
 * funnels — all on its generous free tier (1M events/month, no card required).
 *
 * ONE-TIME SETUP (see README "Usage tracking"):
 *   Already configured with this project's PostHog key below. To point at a
 *   different PostHog project, just swap POSTHOG_KEY / POSTHOG_HOST.
 *
 * PRIVACY: we use anonymous person profiles ("identify" is never called), so no
 * names/emails are ever collected — just a random PostHog-generated id per
 * device. The API key below is a *public* client key (safe to ship in a static
 * site); it can only send events, not read your data.
 */
(function () {
  "use strict";

  // ── Config — this project's PostHog values ──
  const POSTHOG_KEY = "phc_x47Dofx9ZJCYFPQJ9tuSDkErvZ3qrdbXgMEFkk22yw9j";
  // US cloud: https://us.i.posthog.com  ·  EU cloud: https://eu.i.posthog.com
  const POSTHOG_HOST = "https://us.i.posthog.com";

  // Guard: skip if the key was blanked out (keeps the app working without
  // analytics rather than throwing). Normally this is always configured.
  const isConfigured = POSTHOG_KEY.indexOf("phc_") === 0 && POSTHOG_KEY.indexOf("phc_REPLACE") !== 0;

  // ── Load the PostHog snippet (official async loader, 2026-05-30 build) ──
  // Standard PostHog bootstrap: stubs the API so calls made before the script
  // finishes loading are queued, then swapped for the real implementation.
  function loadPostHog() {
    !(function (t, e) {
      var o, n, p, r;
      e.__SV ||
        (window.posthog && window.posthog.__loaded) ||
        ((window.posthog = e),
        (e._i = []),
        (e.init = function (i, s, a) {
          function g(t, e) {
            var o = e.split(".");
            2 == o.length && ((t = t[o[0]]), (e = o[1]));
            t[e] = function () {
              t.push([e].concat(Array.prototype.slice.call(arguments, 0)));
            };
          }
          // onerror nulls the ref so a blocked/failed load doesn't wedge the stub
          p ||
            (((p = t.createElement("script")).type = "text/javascript"),
            (p.crossOrigin = "anonymous"),
            (p.async = !0),
            (p.src = s.api_host.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js"),
            (p.onerror = function () {
              p = null;
            }),
            (r = t.getElementsByTagName("script")[0]).parentNode.insertBefore(p, r));
          var u = e;
          for (
            void 0 !== a ? (u = e[a] = []) : (a = "posthog"),
              (u.people = u.people || []),
              Object.defineProperty(u, "toString", {
                configurable: !0,
                enumerable: !0,
                writable: !0,
                value: function (t) {
                  var e = "posthog";
                  return "posthog" !== a && (e += "." + a), t || (e += " (stub)"), e;
                },
              }),
              Object.defineProperty(u.people, "toString", {
                configurable: !0,
                enumerable: !0,
                writable: !0,
                value: function () {
                  return u.toString(1) + ".people (stub)";
                },
              }),
              (o =
                "Gl Zl Jl Ql Yl init wu ku yu bu Tu Pa Iu pu Pu Fu Ou capture getExtension Su Wl Lu calculateEventProperties Du register register_once register_for_session unregister unregister_for_session Bu mu Nu getFeatureFlag getFeatureFlagPayload getFeatureFlagResult getAllFeatureFlags isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync Hu identify setPersonProperties unsetPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset zu shutdown setIdentity clearIdentity get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException addExceptionStep captureLog startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty qu Au createPersonProfile setInternalOrTestUser ju tu eu opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing Eu debug Fa bs getPageViewId captureTraceFeedback captureTraceMetric du".split(
                  " "
                )),
              n = 0;
            n < o.length;
            n++
          )
            g(u, o[n]);
          e._i.push([i, s, a]);
        }),
        (e.__SV = 1));
    })(document, window.posthog || []);

    // identified_only keeps events anonymous/cheap until you ever call identify()
    // (which we don't) — so every visitor stays an anonymous person profile.
    window.posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      defaults: "2026-05-30",
      person_profiles: "identified_only",
    });
  }

  // ── Public API used by app.js ──
  // Provider-agnostic wrapper so app.js never needs to know it's PostHog.
  window.Analytics = {
    // Log a product action, e.g. Analytics.track("song-open", { extra })
    track: function (name, props) {
      // Only send if PostHog is configured and loaded
      if (isConfigured && window.posthog && typeof window.posthog.capture === "function") {
        window.posthog.capture(name, props || {});
      }
    },
    // Anonymous distinct id PostHog assigned this device (handy for debugging)
    distinctId: function () {
      if (window.posthog && typeof window.posthog.get_distinct_id === "function") {
        return window.posthog.get_distinct_id();
      }
      return null;
    },
  };

  // Only boot PostHog once it's actually configured — avoids console noise and
  // wasted requests before you've pasted your key in.
  if (isConfigured) {
    loadPostHog();
  }
})();

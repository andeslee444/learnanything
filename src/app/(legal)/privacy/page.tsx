/**
 * /privacy — Plain-language privacy policy.
 *
 * Server component, public (no auth required).
 * Contact email rendered from process.env.CONTACT_EMAIL at request time;
 * falls back to a generic phrase so no founder email is baked into the build.
 *
 * TEMPLATE NOTICE: pending legal review, not legal advice.
 */

export const dynamic = 'force-dynamic'; // always renders env at request time

export default function PrivacyPage() {
  const contactEmail = process.env.CONTACT_EMAIL ?? 'the contact address listed on our site';

  return (
    <article className="mx-auto max-w-2xl px-6 py-10 prose prose-ink">
      {/* Template / counsel-review banner */}
      <div
        role="note"
        className="mb-8 rounded-xl border-2 border-sun-400 bg-sun-50 px-6 py-4"
        aria-label="Template notice"
      >
        <p className="text-sm font-semibold text-sun-700">
          TEMPLATE — pending legal review, not legal advice.
        </p>
        <p className="mt-1 text-xs text-ink-600">
          This document is a template draft. It has not been reviewed by qualified legal counsel and
          does not constitute legal advice. The founder should obtain counsel review before relying
          on this policy.
        </p>
      </div>

      <h1 className="text-2xl font-medium text-ink-900">Privacy Policy</h1>
      <p className="mt-1 text-sm text-ink-400">Last updated: June 2026</p>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">What we store</h2>
        <p className="mt-2 text-sm text-ink-700">
          We store the minimum necessary to deliver personalised lessons and track your progress:
        </p>
        <ul className="mt-2 list-disc pl-5 text-sm text-ink-700 space-y-1">
          <li>
            <strong>Account information</strong> — your email address, display name, and hashed
            password.
          </li>
          <li>
            <strong>Learner profile</strong> — your age band, expertise level, and learning
            preferences. No government ID or sensitive personal data.
          </li>
          <li>
            <strong>Tracks, missions, and learning records</strong> — the topics you study, the
            goals you set, and evidence of what you have learned (quiz answers, skill assessments).
          </li>
          <li>
            <strong>Lesson activity</strong> — which lessons you have taken, attempt events,
            flashcard review history, and glossary terms you have mastered.
          </li>
          <li>
            <strong>Uploaded documents (extractions only)</strong> — when you upload a file to
            provide context for a track, we extract structured claims and discard the raw text
            immediately. We do not retain the full text of your upload.
          </li>
          <li>
            <strong>Billing data</strong> — credit balance and Stripe customer/subscription
            identifiers. We never store full card numbers; payment processing is handled entirely
            by Stripe.
          </li>
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">Our promises</h2>
        <ul className="mt-2 list-disc pl-5 text-sm text-ink-700 space-y-2">
          <li>
            <strong>No training on your data.</strong> Your learning content, records, and lesson
            interactions are never used to train AI models — ours or anyone else&apos;s.
          </li>
          <li>
            <strong>No advertising, ever.</strong> We do not sell, rent, or share your data with
            advertisers. There are no ads on this platform and there will not be.
          </li>
          <li>
            <strong>No third-party analytics containing your learning content.</strong> We do not
            send lesson text, record bodies, or glossary terms to third-party analytics or
            telemetry services.
          </li>
          <li>
            <strong>Export anytime.</strong> You can download a complete copy of your data at any
            time in JSON or Markdown format from your account page.
          </li>
          <li>
            <strong>Delete anytime.</strong> You can permanently delete your account and all
            associated data with one click. We retain encrypted backups for up to 30 days after
            deletion, after which your data is permanently unrecoverable. Note: payment records
            are retained by our payment processor (Stripe) under their own policies; anonymized
            research-topic caches that are not tied to your identity may persist.
          </li>
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">Cookies</h2>
        <p className="mt-2 text-sm text-ink-700">
          We use a single session cookie to keep you logged in. We do not use tracking or
          advertising cookies. The session cookie is deleted when you sign out or when your
          session expires.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">AI-generated content</h2>
        <p className="mt-2 text-sm text-ink-700">
          Lessons are generated by AI models using source materials. We include verification badges
          indicating which claims have been checked against cited sources. AI-generated content can
          be imperfect and is not a substitute for professional advice.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">Contact</h2>
        <p className="mt-2 text-sm text-ink-700">
          For privacy questions or data requests, contact us at{' '}
          <span className="font-medium">{contactEmail}</span>.
        </p>
      </section>
    </article>
  );
}

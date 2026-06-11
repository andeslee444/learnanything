/**
 * /terms — Terms of Service.
 *
 * Server component, public (no auth required).
 * Contact email rendered from process.env.CONTACT_EMAIL at request time.
 *
 * TEMPLATE NOTICE: pending legal review, not legal advice.
 */

export const dynamic = 'force-dynamic'; // always renders env at request time

export default function TermsPage() {
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
          on these terms.
        </p>
      </div>

      <h1 className="text-2xl font-medium text-ink-900">Terms of Service</h1>
      <p className="mt-1 text-sm text-ink-400">Last updated: June 2026</p>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">Service description</h2>
        <p className="mt-2 text-sm text-ink-700">
          LearnAnything is an AI-powered learning platform that generates personalised, source-backed
          lessons tailored to your goals, expertise, and learning context. Lessons are generated
          using AI models and verified against cited sources.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">Age requirement</h2>
        <p className="mt-2 text-sm text-ink-700">
          You must be 13 years of age or older to use LearnAnything. By creating an account, you
          confirm that you meet this requirement. Users aged 13–17 should have parental or guardian
          consent where required by applicable law.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">Acceptable use</h2>
        <p className="mt-2 text-sm text-ink-700">You agree not to:</p>
        <ul className="mt-2 list-disc pl-5 text-sm text-ink-700 space-y-1">
          <li>Use the platform for unlawful purposes or to violate any applicable law.</li>
          <li>Attempt to reverse-engineer, scrape, or circumvent rate limits or access controls.</li>
          <li>
            Upload content that infringes third-party intellectual property rights, is defamatory,
            or contains malware.
          </li>
          <li>
            Use the service to generate content that facilitates harm to minors or constitutes
            illegal harassment.
          </li>
          <li>Misrepresent your identity or affiliation when using the service.</li>
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">Credits and billing</h2>
        <ul className="mt-2 list-disc pl-5 text-sm text-ink-700 space-y-2">
          <li>
            <strong>Free tier</strong> — 3 lesson credits per month, no rollover.
          </li>
          <li>
            <strong>Subscription</strong> — $15/month for 30 lesson credits per month. Credits are
            granted at the start of each billing period and do not roll over.
          </li>
          <li>
            <strong>Credits are non-refundable</strong> except where required by applicable law
            (e.g. consumer protection rights in your jurisdiction).
          </li>
          <li>
            <strong>Cancellation</strong> — you may cancel your subscription at any time. Your
            subscription remains active until the end of the paid period. Credits already granted
            for the current period remain available until they expire. If you wish to delete your
            account, you must cancel your subscription first — account deletion does not
            automatically cancel your Stripe subscription.
          </li>
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">AI-generated content disclaimer</h2>
        <p className="mt-2 text-sm text-ink-700">
          Lessons are AI-generated. We include source verification badges indicating which claims
          have been checked against cited sources. Despite these checks, AI-generated content can
          be imperfect, incomplete, or out of date. Lesson content is provided for educational
          purposes only and does not constitute professional advice — including but not limited to
          medical, legal, financial, or engineering advice. Always consult a qualified professional
          where appropriate.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">Copyright / DMCA</h2>
        <p className="mt-2 text-sm text-ink-700">
          We respect intellectual property rights. If you believe that content shared on LearnAnything
          infringes your copyright, you may submit a DMCA takedown notice to us at{' '}
          <span className="font-medium">{contactEmail}</span>. Your notice must include: (1) identification
          of the copyrighted work claimed to be infringed; (2) the specific URL(s) of the allegedly
          infringing material; (3) your contact information; (4) a good-faith statement that the use
          is not authorised; and (5) a statement under penalty of perjury that the information is
          accurate and that you are authorised to act on behalf of the copyright owner, together with
          your signature. Incomplete notices cannot be processed. The full notice procedure, counter-notice
          process (10–14 business-day window per 17 U.S.C. § 512(g)), and repeat-infringer policy
          are described in detail in our internal takedown procedure — the complete process is
          available on request at <span className="font-medium">{contactEmail}</span>.
        </p>
        <p className="mt-2 text-sm text-ink-700">
          <strong>Repeat-infringer policy:</strong> In accordance with 17 U.S.C. § 512(i), we maintain
          a policy of terminating, in appropriate circumstances, accounts of users who are repeat
          infringers of third-party intellectual property rights. Users who receive multiple valid
          DMCA notices may have their sharing privileges suspended and, ultimately, their accounts
          terminated.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">Governing law</h2>
        <p className="mt-2 text-sm text-ink-700">
          <span className="text-ink-400 italic">
            [Governing law and jurisdiction placeholder — to be completed upon counsel review.]
          </span>
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">Changes to these terms</h2>
        <p className="mt-2 text-sm text-ink-700">
          We may update these terms from time to time. Material changes will be communicated to
          registered users via email. Continued use of the service after changes constitutes
          acceptance of the updated terms.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink-900">Contact</h2>
        <p className="mt-2 text-sm text-ink-700">
          For questions about these terms, contact us at{' '}
          <span className="font-medium">{contactEmail}</span>.
        </p>
      </section>
    </article>
  );
}

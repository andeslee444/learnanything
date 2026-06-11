# DMCA Takedown Process

> **TEMPLATE — pending legal review.**  
> This document is a template draft. It has not been reviewed by qualified legal counsel and does not constitute legal advice. The founder should obtain counsel review before public launch and before executing any step described here.

---

## 1. Receiving a DMCA Notice

DMCA takedown notices must be submitted in writing (email accepted) to the designated agent contact address configured in `CONTACT_EMAIL`. Until the agent is registered (see §6), notices may also be sent to the same address.

---

## 2. Required Elements of a Valid DMCA Notice (17 U.S.C. § 512(c)(3))

A valid DMCA takedown notice must include all of the following:

1. **Identification of the copyrighted work** — a description of the copyrighted work that you claim has been infringed, or if multiple works are covered, a representative list.
2. **Identification of the infringing material and its location** — a description of where the infringing material is located on the service, including the specific URL(s) (e.g. `https://learnanything.app/learn/{vertical}/{slug}`), specific enough for us to locate the material.
3. **Contact information** — your name, mailing address, telephone number, and email address so we can reach you.
4. **Good-faith statement** — a statement that you have a good-faith belief that use of the material in the manner complained of is not authorised by the copyright owner, its agent, or the law.
5. **Accuracy statement and signature** — a statement that the information in the notification is accurate, and, under penalty of perjury, that you are authorised to act on behalf of the copyright owner. The notice must be signed (electronic signature is acceptable).

Notices that are materially incomplete will not be processed. We will make a reasonable attempt to contact the sender to request the missing elements.

---

## 3. Processing a Valid Notice

1. **Validate** — confirm all required elements are present (§2 above). Incomplete notices are returned with a request to complete them.
2. **Take down** — upon receiving a valid notice, the founder (or designated admin) sets `moderationStatus = 'removed'` for the identified `shared_lessons` row via the admin queue. This removes the public page immediately (public pages return 404 for `moderationStatus !== 'approved'`; the `removed` status is sticky and is not owner-deletable).
3. **Notify the sharer** — send a notification (via `CONTACT_EMAIL`) to the user who shared the lesson, informing them that their shared lesson has been taken down and explaining the counter-notice process.
4. **Record** — retain the notice and the action taken in an internal log for at least three years.

---

## 4. Counter-Notice Process (17 U.S.C. § 512(g))

A user who believes their content was wrongly removed may send a counter-notice to `CONTACT_EMAIL`. A valid counter-notice must include:

1. Identification of the material that was removed and the URL where it appeared.
2. A statement under penalty of perjury that the user has a good-faith belief that the material was removed by mistake or misidentification.
3. The user's name, address, telephone number, and email address.
4. Consent to jurisdiction of the federal district court for the district in which the user's address is located (or, for users outside the US, any judicial district in which the service provider may be found).
5. The user's physical or electronic signature.

Upon receipt of a valid counter-notice, the founder will:

1. Forward the counter-notice to the original complainant.
2. **Wait 10–14 business days** (per 17 U.S.C. § 512(g)(2)(C)) before restoring the material, unless the complainant notifies us they have filed a court action to restrain the user.
3. Restore the material (set `moderationStatus = 'approved'`) if no court action is notified within the window.

---

## 5. Repeat-Infringer Policy

In accordance with 17 U.S.C. § 512(i), LearnAnything maintains a policy for terminating, in appropriate circumstances, the accounts of users who are repeat infringers of copyright.

**Strikes:**

- **First valid DMCA notice** for a user: content removed, user notified. Strike logged internally.
- **Second valid DMCA notice** within 12 months: content removed, user issued a formal warning and temporary sharing suspension.
- **Third valid DMCA notice** (or second within 3 months): account terminated. Shared lessons permanently removed.

Frivolous or fraudulent notices (submitted under penalty of perjury) are not counted as valid notices toward this policy and may be reported to appropriate authorities.

This policy is referenced in the Terms of Service under the Copyright / DMCA section.

---

## 6. Agent Registration (Founder Action Required Before First Public Share)

To obtain safe-harbour protection under 17 U.S.C. § 512, the service must have a registered DMCA Designated Agent. This is a one-time administrative step that the founder must complete **before the first public lesson is shared**.

**Steps:**

1. Go to the US Copyright Office DMCA Designated Agent Directory:  
   <https://www.copyright.gov/dmca-directory/>
2. Create an account and register the service (LearnAnything) as an online service provider.
3. Provide the agent's contact information (name, address, phone, email — this becomes public).
4. Pay the $6 registration fee.
5. **Renew every 3 years** (the Copyright Office will send a reminder; failure to renew terminates safe-harbour protection).
6. Update `CONTACT_EMAIL` in production to match the registered agent's email address (or a dedicated DMCA mailbox that the agent monitors).
7. The registered agent's name and contact information must be publicly accessible on the service — the `/terms` page references `CONTACT_EMAIL` for this purpose.

---

## 7. Internal Admin Actions

The admin queue at `/admin` (server component, founder-only) can set `moderationStatus` for any `shared_lessons` row. Takedowns use the `'removed'` status, which:

- Makes the public page return 404 immediately.
- Is sticky: the owner cannot delete or re-approve a `'removed'` row via the share/unshare API.
- Can only be changed by an admin action.

Restoration after a successful counter-notice: set `moderationStatus = 'approved'` via the admin queue.

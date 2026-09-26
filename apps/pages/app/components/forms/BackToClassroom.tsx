/**
 * The way out of the forms admin and back into Classmoji.
 *
 * The forms screens are served by the pages app on a different origin from the
 * webapp, so there is no nav shell around them and no in-app link that could
 * lead anywhere but deeper into forms. Staff arriving from the classroom's
 * Forms nav entry had nothing to click to get back.
 *
 * It now points at the webapp's FORMS list (`formsListUrl`) rather than the
 * classroom dashboard, because that list is where staff come from: the nav
 * entry opens it in the webapp, and only New Form / Edit / Responses cross to
 * this app. The label stays the classroom's name — which course you are
 * returning to is the part that is not obvious from the screen you are on.
 *
 * A plain `<a>`, not a `<Link>`: the target is another origin, and a client-side
 * navigation to it would only be a 404 inside this router.
 */
export function BackToClassroom({ href, name }: { href: string; name: string }) {
  return (
    <a
      href={href}
      title="Back to this classroom's forms in Classmoji"
      className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
    >
      ← {name}
    </a>
  );
}

export default BackToClassroom;

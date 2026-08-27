// Re-export from the admin route — the quiz management list, since managing
// quizzes is the point of granting this role the surface. Same loader, same
// action, same gates; this file adds no policy of its own, so anything true of
// the admin route is true here.
export { loader, action, default } from '../admin.$class.quizzes/route';

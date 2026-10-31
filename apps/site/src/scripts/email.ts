/** Something, an @, a domain with a dot. The wait-list action (#185) checks the address again on the server. */
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What is wrong with a typed email, in the words the form shows, or "" when it looks right. */
export const emailProblem = (email: string) => {
  if (!email) return "Type your email address first.";
  if (!EMAIL.test(email)) return "That email looks incomplete. Check for an @ and a domain, like you@example.com.";
  return "";
};

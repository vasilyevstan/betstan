const getRouteIdentity = (pathname) => {
  const normalizedPathname = typeof pathname === 'string'
    ? pathname.toLowerCase()
    : '/';
  const withoutTrailingSlashes = normalizedPathname.replace(/\/+$/, '');
  if (/^\/backoffice(\/events\/[^/]+)?\/markets$/.test(withoutTrailingSlashes)) return '/backoffice';
  if (/^\/events\/[^/]+\/markets$/.test(withoutTrailingSlashes)) return '/';
  return withoutTrailingSlashes || '/';
};

export default getRouteIdentity;

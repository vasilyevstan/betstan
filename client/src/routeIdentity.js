const getRouteIdentity = (pathname) => {
  const normalizedPathname = typeof pathname === 'string'
    ? pathname.toLowerCase()
    : '/';
  const withoutTrailingSlashes = normalizedPathname.replace(/\/+$/, '');
  return withoutTrailingSlashes || '/';
};

export default getRouteIdentity;

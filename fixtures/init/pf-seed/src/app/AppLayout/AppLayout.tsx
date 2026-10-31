import * as React from 'react';
import { NavLink } from 'react-router-dom';
import { routes } from '@app/routes';

export const AppLayout: React.FunctionComponent<{ children: React.ReactNode }> = ({ children }) => (
  <div>
    <nav aria-label="Global">
      {routes.map((route, idx) =>
        'path' in route ? (
          <NavLink key={idx} to={route.path}>
            {route.label}
          </NavLink>
        ) : null,
      )}
    </nav>
    <main>{children}</main>
  </div>
);

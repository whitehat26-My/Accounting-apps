import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { RequestMethod } from '@nestjs/common';
import { MetadataScanner } from '@nestjs/core';
import type { HttpMethod, RouteDescriptor } from '@emil/contracts';
import { NO_IDEMPOTENCY_KEY, PUBLIC_KEY, REQUIRED_PERMISSION } from '../guards/decorators.js';
import { DOC_METADATA, type RouteDoc } from './doc.decorator.js';

/**
 * Enumerate the routes the application actually serves.
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE SAME METADATA THE ROUTER AND THE GUARD USE.
 *
 * `PATH_METADATA` and `METHOD_METADATA` are what Nest itself reads to build the
 * router. `PUBLIC_KEY` and `REQUIRED_PERMISSION` are what `AuthGuard` reads to
 * decide whether to let a request through. This module reads exactly those, so
 * the generated document describes the application rather than describing an
 * intention about it.
 *
 * The alternative — a hand-written list of routes, or Nest's `@ApiOperation`
 * decorators restating the path — can disagree with the router, and does, and
 * nothing fails when it happens. That is the failure this avoids: a spec that
 * lies about which permission an endpoint needs is worse than one that says
 * nothing, because a reviewer will believe it.
 * ---------------------------------------------------------------------------
 */

const METHOD_NAMES: Partial<Record<RequestMethod, HttpMethod>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

type Constructor = new (...args: never[]) => object;

export function scanRoutes(controllers: readonly Constructor[]): RouteDescriptor[] {
  const scanner = new MetadataScanner();
  const routes: RouteDescriptor[] = [];

  for (const controller of controllers) {
    const controllerPath = normalise(
      (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '',
    );

    // Controller-level metadata is inherited by every handler that does not
    // override it — the same resolution `Reflector.getAllAndOverride` performs
    // in the guard, mirrored here so the document agrees with enforcement.
    const controllerPublic = Reflect.getMetadata(PUBLIC_KEY, controller) === true;
    const controllerPermission = Reflect.getMetadata(REQUIRED_PERMISSION, controller) as
      | string
      | undefined;

    const prototype = controller.prototype as object;

    for (const handler of scanner.getAllMethodNames(prototype)) {
      const fn = (prototype as Record<string, unknown>)[handler];
      if (typeof fn !== 'function') continue;

      const requestMethod = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
      const handlerPath = Reflect.getMetadata(PATH_METADATA, fn) as string | undefined;

      // A method with no HTTP metadata is a helper, not a route.
      if (requestMethod === undefined || handlerPath === undefined) continue;

      const httpMethod = METHOD_NAMES[requestMethod];
      if (!httpMethod) continue;

      const doc = Reflect.getMetadata(DOC_METADATA, fn) as RouteDoc | undefined;

      /*
       * Whether the route takes a body is REFLECTED, not assumed.
       *
       * The first version treated every POST/PATCH/PUT/DELETE as taking one,
       * and then reported `POST /v1/sandbox/statutory-values` — whose handler
       * has no `@Body()` at all — as an undocumented body. Documenting a body
       * that does not exist is the same class of error as failing to document
       * one that does: a generated client would require a payload the server
       * ignores.
       *
       * Nest records parameter decorators under `ROUTE_ARGS_METADATA`, keyed
       * `<paramtype>:<index>`, on the CONTROLLER rather than the handler.
       */
      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handler) ??
        {}) as Record<string, unknown>;
      const expectsBody = Object.keys(args).some((key) =>
        key.startsWith(`${RouteParamtypes.BODY}:`),
      );
      const permission =
        (Reflect.getMetadata(REQUIRED_PERMISSION, fn) as string | undefined) ??
        controllerPermission;

      routes.push({
        method: httpMethod,
        path: join(controllerPath, normalise(handlerPath)),
        controller: controller.name,
        handler,
        ...(permission !== undefined ? { permission } : {}),
        isPublic: Reflect.getMetadata(PUBLIC_KEY, fn) === true || controllerPublic,
        exemptFromIdempotency: Reflect.getMetadata(NO_IDEMPOTENCY_KEY, fn) === true,
        expectsBody,
        ...(doc?.summary !== undefined ? { summary: doc.summary } : {}),
        ...(doc?.description !== undefined ? { description: doc.description } : {}),
        ...(doc?.request !== undefined ? { request: doc.request() } : {}),
        ...(doc?.response !== undefined ? { response: doc.response() } : {}),
        ...(doc?.deprecated !== undefined ? { deprecated: doc.deprecated } : {}),
        ...(doc?.externalBody !== undefined ? { externalBody: doc.externalBody } : {}),
      });
    }
  }

  return routes;
}

function normalise(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  return trimmed;
}

function join(controllerPath: string, handlerPath: string): string {
  const parts = [controllerPath, handlerPath].filter((p) => p.length > 0);
  return `/${parts.join('/')}`;
}

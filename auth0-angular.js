(function () {

  var util = angular.module('util', []);

  util.factory('$safeApply', function safeApplyFactory($rootScope, $exceptionHandler) {
    return function safeApply(scope, expr) {
      scope = scope || $rootScope;
      if (['$apply', '$digest'].indexOf(scope.$root.$$phase) !== -1) {
        try {
          return scope.$eval(expr);
        } catch (e) {
          $exceptionHandler(e);
        }
      } else {
        return scope.$apply(expr);
      }
    };
  });

  //this is used to parse the profile
  util.value('urlBase64Decode', function (str) {
    var output = str.replace('-', '+').replace('_', '/');
    switch (output.length % 4) {
      case 0: { break; }
      case 2: { output += '=='; break; }
      case 3: { output += '='; break; }
      default: {
        throw 'Illegal base64url string!';
      }
    }
    return window.atob(output); //polifyll https://github.com/davidchambers/Base64.js
  });

  var auth0 = angular.module('auth0-auth', ['util', 'ngCookies', 'ngRoute']);

  function Auth0Wrapper(auth0Lib, $cookies, $rootScope, $safeApply, $q, urlBase64Decode) {
    this.auth0Lib = auth0Lib;
    this.$cookies    = $cookies;
    this.$rootScope  = $rootScope;
    this.$safeApply  = $safeApply;
    this.$q          = $q;

    this.urlBase64Decode = urlBase64Decode;

    this.delegatedTokens = {};
  }

  Auth0Wrapper.prototype = {};

  Auth0Wrapper.prototype.parseHash = function (locationHash, callback) {
    this.auth0Lib.parseHash(locationHash, callback);
  };

  Auth0Wrapper.prototype._deserialize = function () {
    if (!this.$cookies.profile) {
      this.isAuthenticated = false;
      this.profile = undefined;
      this.idToken = undefined;
      this.accessToken = undefined;
      return;
    }

    this.profile = JSON.parse(this.$cookies.profile);
    this.isAuthenticated = !!this.profile;
    this.idToken = this.$cookies.idToken;
    this.accessToken = this.$cookies.accessToken;
  };

  Auth0Wrapper.prototype._serialize = function (profile, id_token, access_token) {
    this.$cookies.profile = JSON.stringify(profile);
    this.$cookies.idToken = id_token;
    this.$cookies.accessToken = access_token;
  };

  Auth0Wrapper.prototype.hasTokenExpired = function (token) {
    if (!token) {
      return true;
    }

    var parts = token.split('.');

    if (parts.length !== 3) {
      return true;
    }

    var decoded = this.urlBase64Decode(parts[1]);
    if (!decoded) {
      return true;
    }

    try {
      decoded = JSON.parse(decoded);
    } catch (e) {
      return true;
    }

    if(!decoded.exp) {
      return true;
    }

    var d = new Date(0); // The 0 there is the key, which sets the date to the epoch
    d.setUTCSeconds(decoded.exp);

    if (isNaN(d)) {
      return true;
    }

    // Token expired?
    if( d.valueOf() > new Date().valueOf()) {
      // No
      return false;
    } else {
      // Yes
      return true;
    }
  };

  Auth0Wrapper.prototype.getToken = function (clientID, options, forceRenewal) {
    options = options || { scope: 'openid' };

    var that = this;
    var deferred = that.$q.defer();

    if (forceRenewal) {
      this.delegatedTokens[clientID] = undefined;
    }

    var existingToken = this.delegatedTokens[clientID];
    var isExpired = this.hasTokenExpired(existingToken);

    // If token was already retrieved and is not expired return it
    if (existingToken && !isExpired) {
      deferred.resolve(existingToken);
      return deferred.promise;
    }

    this.auth0Lib.getDelegationToken(clientID, this.idToken, options, this._wrapCallback(function (err, delegationResult) {
      if (err) {
        return deferred.reject(err);
      }

      that.delegatedTokens[clientID] = delegationResult.id_token;

      return deferred.resolve(delegationResult.id_token);
    }));

    return deferred.promise;
  };

  Auth0Wrapper.prototype.signin = function (options, callback) {
    options = options || {};

    var that = this;
    var deferred = that.$q.defer();

    if (!options.popup && callback) {
      throw new Error('Since you are using "redirect" mode, the callback you defined will never be called.');
    }

    that.auth0Lib.signin(options, function(err, profile, id_token, access_token, state) {
      if (err) {
        return deferred.reject(err);
      }
      
      that._serialize(profile, id_token, access_token, state);
      that._deserialize();
      
      that.$safeApply(undefined, callback);

      return deferred.resolve();
    });

    return deferred.promise;
  };

  Auth0Wrapper.prototype.signout = function () {
    this._serialize(undefined, undefined, undefined);
    this._deserialize();
  };

  Auth0Wrapper.prototype._wrapCallback = function (callback) {
    var that = this;
    return function () {
      return that.$safeApply(undefined, callback.apply(null, arguments));
    };
  };

  Auth0Wrapper.prototype.getProfile = function (locationHash, callback) {
    var that = this;

    var wrappedCallback = function() {
      that.$safeApply(undefined, callback.apply(null, arguments));
    };

    this.auth0Lib.getProfile(locationHash, wrappedCallback);
  };

  Auth0Wrapper.prototype.signup = function (options) {
    this.auth0Lib.signup(options);
  };

  Auth0Wrapper.prototype.reset = function (options) {
    this.auth0Lib.reset(options);
  };

  auth0.provider('auth', function ($provide) {
    var auth0Wrapper;

    this.init = function (options) {
      var auth0Lib;

      if (options.callbackOnLocationHash === undefined) {
        options.callbackOnLocationHash = true;
      }

      // User has included widget
      if (typeof Auth0Widget !== 'undefined') {
        auth0Lib = new Auth0Widget(options);
      } else if (typeof Auth0 !== 'undefined') {
        auth0Lib = new Auth0(options);
      } else {
        throw new Error('You need to add Auth0Widget or Auth0.js dependency');
      }

      $provide.value('auth0Lib', auth0Lib);
    };

    this.$get = function ($cookies, $rootScope, $safeApply, $q, $injector, urlBase64Decode) {
      // We inject auth0Lib manually in order to throw a friendly error
      var auth0Lib = $injector.get('auth0Lib');
      if (!auth0Lib) {
        throw new Error('You need to add Auth0Widget or Auth0.js dependency');
      }

      if (!auth0Wrapper) {
        auth0Wrapper = new Auth0Wrapper(auth0Lib, $cookies, $rootScope, $safeApply, $q, urlBase64Decode);
      }

      return auth0Wrapper;
    };
  });

  var auth0Main = angular.module('auth0', ['auth0-auth']);

  // Why $route if we are not using it? See https://github.com/angular/angular.js/issues/1213
  auth0Main.run(function (auth, $cookies, $location, $rootScope, $window, $route) {

    // this is only used when doing social authentication in redirect mode (auth.signin({connection: 'google-oauth2'});)
    auth.getProfile($window.location.hash, function (err, profile, id_token, access_token, state) {
      if (err) {
        return $rootScope.$broadcast('auth:error', err);
      }

      auth._serialize(profile, id_token, access_token, state);
      auth._deserialize();

      $location.path('/');
    });

    // this will rehydrate the "auth" object with the profile stored in $cookies
    auth._deserialize();
  });

  var authInterceptorModule = angular.module('authInterceptor', ['auth0-auth']);

  authInterceptorModule.factory('authInterceptor', function (auth, $rootScope, $q) {
    return {
      request: function (config) {
        config.headers = config.headers || {};
        if (auth.idToken) {
          config.headers.Authorization = 'Bearer '+ auth.idToken;
        }
        return config;
      },
      responseError: function (response) {
        // handle the case where the user is not authenticated
        if (response.status === 401) {
          $rootScope.$broadcast('auth:forbidden', response);
        }
        return response || $q.when(response);
      }
    };
  });

}());

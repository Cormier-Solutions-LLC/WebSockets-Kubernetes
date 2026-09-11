package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

type SessionStore struct{ client *redis.Client }

func ConnectStore(redisURL string) (*SessionStore, error) {
	options, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	options.DialTimeout = 5 * time.Second
	options.ReadTimeout = 5 * time.Second
	options.WriteTimeout = 5 * time.Second
	client := redis.NewClient(options)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, err
	}
	return &SessionStore{client}, nil
}

func (s *SessionStore) Ready(ctx context.Context) bool { return s.client.Ping(ctx).Err() == nil }
func (s *SessionStore) Get(ctx context.Context, key string) (string, error) {
	return s.client.Get(ctx, key).Result()
}
func (s *SessionStore) Put(ctx context.Context, key, value string, ttl time.Duration) error {
	return s.client.Set(ctx, key, value, ttl).Err()
}
func (s *SessionStore) Remove(ctx context.Context, key string) error {
	return s.client.Del(ctx, key).Err()
}
func (s *SessionStore) Close() error { return s.client.Close() }

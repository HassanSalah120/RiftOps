package platform

import (
	"reflect"
	"testing"

	"github.com/HassanSalah120/RiftOps/internal/model"
)

func TestLaunchArguments(t *testing.T) {
	request := LaunchRequest{ConfigURL: "http://127.0.0.1:1234", Game: model.GameLeague, Patchline: "live",
		RiotClientArgs: []string{"--allow-multiple-clients"}, GameArgs: []string{"--locale=en_US"}}
	got, err := request.Arguments()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--client-config-url=http://127.0.0.1:1234", "--launch-product=league_of_legends", "--launch-patchline=live", "--allow-multiple-clients", "--", "--locale=en_US"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

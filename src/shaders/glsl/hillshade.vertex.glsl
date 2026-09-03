uniform mat4 u_matrix;
uniform sampler2D u_image;

layout(location = 0) in vec2 a_pos;

out vec2 v_pos;

void main() {
    gl_Position = projectTile(a_pos, a_pos);
    v_pos = a_pos / 8192.0;
    // North pole
    if (a_pos.y < -32767.5) {
        v_pos.y = 0.0;
    }
    // South pole
    if (a_pos.y > 32766.5) {
        v_pos.y = 1.0;
    }
    vec2 size = vec2(textureSize(u_image, 0));
    v_pos = (v_pos * (size - 2.0) + 1.0) / size;
}
